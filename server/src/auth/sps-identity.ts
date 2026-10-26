import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import { authSessions, authUsers } from "../compat/paperclip/db.js";
import type { Config } from "../config.js";
import type { SpsNativePairingTransaction } from "../services/sps-native-pairings.js";
import type { BetterAuthSessionResult } from "./better-auth.js";

const SESSION_COOKIE = "sps_identity_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_NATIVE_COOKIE_HEADER_LENGTH = 8_192;
const NATIVE_SESSION_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export type SpsIdentityNativeEnrollmentSession = Readonly<{
  userId: string;
  authorizeInTransaction(tx: SpsNativePairingTransaction, expectedUserId: string): Promise<void>;
}>;

type IdentityJwk = {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
};

type IdentityClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  picture?: unknown;
  scope?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

type IdentityProfile = {
  subject: string;
  email: string;
  name: string;
  picture: string | null;
};

type SessionMetadata = { ipAddress: string | null; userAgent: string | null };
type SessionWriter = Pick<Db, "insert">;

function value(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function base64UrlJson(input: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("SPS Identity token is invalid.");
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function sessionTokenFromHeaders(headers: Headers): string | null {
  const raw = headers.get("cookie") ?? "";
  for (const entry of raw.split(";")) {
    const [name, ...parts] = entry.trim().split("=");
    if (name !== SESSION_COOKIE) continue;
    const token = parts.join("=").trim();
    return token || null;
  }
  return null;
}

function nativeSessionUnavailable(): Error {
  return new Error("SPS Identity session is unavailable.");
}

function nativeSessionTokenFromHeaders(headers: Headers): string {
  try {
    if (!(headers instanceof Headers)) throw nativeSessionUnavailable();
    const raw = Headers.prototype.get.call(headers, "cookie");
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_NATIVE_COOKIE_HEADER_LENGTH) {
      throw nativeSessionUnavailable();
    }
    let token: string | null = null;
    for (const rawEntry of raw.split(";")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const separator = entry.indexOf("=");
      const name = (separator < 0 ? entry : entry.slice(0, separator)).trim();
      if (name !== SESSION_COOKIE) continue;
      if (token !== null || separator < 0) throw nativeSessionUnavailable();
      const candidate = entry.slice(separator + 1);
      if (!NATIVE_SESSION_TOKEN.test(candidate)) throw nativeSessionUnavailable();
      token = candidate;
    }
    if (!token) throw nativeSessionUnavailable();
    return token;
  } catch {
    throw nativeSessionUnavailable();
  }
}

function assertNativeSessionLive(expiresAtMs: number) {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw nativeSessionUnavailable();
}

function headerToken(request: Request): string | null {
  const raw = request.header("authorization") ?? "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokenAudienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.some((entry) => entry === expected));
}

function hasRequiredScope(value: unknown): boolean {
  const scopes = typeof value === "string"
    ? value.split(/\s+/)
    : Array.isArray(value) ? value : [];
  return scopes.includes("sps.core.session");
}

function profileFromClaims(claims: IdentityClaims): IdentityProfile {
  const subject = value(claims.sub);
  const email = value(claims.email);
  if (!subject || !email) throw new Error("SPS Identity token has no verified account.");
  return {
    subject,
    email,
    name: value(claims.name) || email,
    picture: value(claims.picture) || null,
  };
}

function localUserId(subject: string): string {
  return `sps_identity_${sha256(subject)}`;
}

function isSecureSessionCookie(config: Config): boolean {
  return config.authPublicBaseUrl?.startsWith("https://") === true;
}

function setSessionCookie(response: Response, token: string, config: Config) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSessionCookie(config),
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function clearSessionCookie(response: Response, config: Config) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSessionCookie(config),
    path: "/",
  });
}

export function isSpsIdentityEnabled(config: Pick<Config, "authIdentityEnabled">): boolean {
  return config.authIdentityEnabled;
}

export function createSpsIdentityAuth(db: Db, config: Config) {
  if (!isSpsIdentityEnabled(config) || !config.authIdentityIssuer || !config.authIdentityJwksUrl) {
    throw new Error("SPS Identity is not configured for this Core instance.");
  }

  let cachedJwks: IdentityJwk[] = [];
  let jwksExpiresAt = 0;

  async function loadJwks() {
    if (cachedJwks.length > 0 && jwksExpiresAt > Date.now()) return cachedJwks;
    const response = await fetch(config.authIdentityJwksUrl!, { signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null) as { keys?: IdentityJwk[] } | null;
    if (!response.ok || !Array.isArray(payload?.keys)) {
      throw new Error("SPS Identity signing keys are unavailable.");
    }
    cachedJwks = payload.keys.filter((key) => key?.kty === "RSA" && value(key.kid) && value(key.n) && value(key.e));
    if (cachedJwks.length === 0) throw new Error("SPS Identity returned no usable signing keys.");
    jwksExpiresAt = Date.now() + JWKS_CACHE_TTL_MS;
    return cachedJwks;
  }

  async function verifyAccessToken(token: string): Promise<IdentityProfile> {
    const parts = value(token).split(".");
    if (parts.length !== 3) throw new Error("SPS Identity token is invalid.");
    const header = base64UrlJson(parts[0]);
    const claims = base64UrlJson(parts[1]) as IdentityClaims;
    if (header.alg !== "RS256" || !value(header.kid)) throw new Error("SPS Identity token uses an unsupported signature.");
    const key = (await loadJwks()).find((candidate) => candidate.kid === header.kid);
    if (!key) throw new Error("SPS Identity signing key is not recognized.");
    const publicKey = createPublicKey({ key, format: "jwk" });
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid) throw new Error("SPS Identity token signature is invalid.");
    const now = Math.floor(Date.now() / 1000);
    if (
      value(claims.iss) !== config.authIdentityIssuer
      || !tokenAudienceIncludes(claims.aud, config.authIdentityAudience)
      || !hasRequiredScope(claims.scope)
      || typeof claims.exp !== "number"
      || claims.exp <= now
      || (typeof claims.nbf === "number" && claims.nbf > now + 30)
    ) {
      throw new Error("SPS Identity token is not valid for this Core.");
    }
    return profileFromClaims(claims);
  }

  async function upsertUser(profile: IdentityProfile, writer: SessionWriter): Promise<string> {
    const userId = localUserId(profile.subject);
    const now = new Date();
    await writer
      .insert(authUsers)
      .values({
        id: userId,
        name: profile.name,
        email: profile.email,
        emailVerified: true,
        image: profile.picture,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: authUsers.id,
        set: {
          name: profile.name,
          email: profile.email,
          image: profile.picture,
          emailVerified: true,
          updatedAt: now,
        },
      });
    return userId;
  }

  async function createSession(profile: IdentityProfile, metadata: SessionMetadata, writer: SessionWriter,
    assertRequestActive: () => void): Promise<string> {
    assertRequestActive();
    const userId = await upsertUser(profile, writer);
    assertRequestActive();
    const rawToken = randomBytes(48).toString("base64url");
    const now = new Date();
    await writer.insert(authSessions).values({
      id: `sps_identity_${randomBytes(18).toString("base64url")}`,
      token: sha256(rawToken),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
      updatedAt: now,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });
    assertRequestActive();
    return rawToken;
  }

  // Shared authentication/persistence only. Native transport and pairing
  // authority remain separate; this grants no membership or device approval.
  async function exchangeSession(accessToken: string, metadata: SessionMetadata,
    assertRequestActive: () => void = () => {}) {
    if (typeof assertRequestActive !== "function") throw nativeSessionUnavailable();
    assertRequestActive();
    const profile = await verifyAccessToken(accessToken);
    assertRequestActive();
    const token = await db.transaction(tx => createSession(profile, metadata, tx, assertRequestActive));
    // A disconnected request must not receive a committed credential. This
    // check cannot undo a completed COMMIT and must never imply rollback.
    assertRequestActive();
    return Object.freeze({ profile: Object.freeze(profile), token,
      expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000) });
  }

  async function resolveSessionFromHeaders(headers: Headers): Promise<BetterAuthSessionResult | null> {
    const rawToken = sessionTokenFromHeaders(headers);
    if (!rawToken) return null;
    const session = await db
      .select({ id: authSessions.id, userId: authSessions.userId })
      .from(authSessions)
      .where(and(eq(authSessions.token, sha256(rawToken)), gt(authSessions.expiresAt, new Date())))
      .then((rows) => rows[0] ?? null);
    if (!session) return null;
    const user = await db
      .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, session.userId))
      .then((rows) => rows[0] ?? null);
    if (!user) return null;
    return { session, user };
  }

  async function resolveNativeEnrollmentSessionFromHeaders(
    headers: Headers,
  ): Promise<SpsIdentityNativeEnrollmentSession> {
    try {
      const tokenHash = sha256(nativeSessionTokenFromHeaders(headers));
      const sessions = await db
        .select({
          id: authSessions.id,
          token: authSessions.token,
          userId: authSessions.userId,
          expiresAt: authSessions.expiresAt,
        })
        .from(authSessions)
        .where(eq(authSessions.token, tokenHash))
        .limit(2);
      if (!Array.isArray(sessions) || sessions.length !== 1) throw nativeSessionUnavailable();
      const session = sessions[0];
      if (!session || typeof session.id !== "string" || !session.id
        || session.token !== tokenHash || typeof session.userId !== "string" || !session.userId
        || !(session.expiresAt instanceof Date)) {
        throw nativeSessionUnavailable();
      }
      const expiresAtMs = session.expiresAt.getTime();
      assertNativeSessionLive(expiresAtMs);

      const users = await db
        .select({ id: authUsers.id, emailVerified: authUsers.emailVerified })
        .from(authUsers)
        .where(eq(authUsers.id, session.userId))
        .limit(2);
      assertNativeSessionLive(expiresAtMs);
      if (!Array.isArray(users) || users.length !== 1 || users[0]?.id !== session.userId
        || users[0]?.emailVerified !== true) {
        throw nativeSessionUnavailable();
      }

      const sessionId = session.id;
      const userId = session.userId;
      const expiresAt = new Date(expiresAtMs);
      const authorizeInTransaction = async (
        tx: SpsNativePairingTransaction,
        expectedUserId: string,
      ): Promise<void> => {
        try {
          if (expectedUserId !== userId) throw nativeSessionUnavailable();
          assertNativeSessionLive(expiresAtMs);
          const currentSessions = await tx
            .select({
              id: authSessions.id,
              token: authSessions.token,
              userId: authSessions.userId,
              expiresAt: authSessions.expiresAt,
            })
            .from(authSessions)
            .where(and(
              eq(authSessions.id, sessionId),
              eq(authSessions.token, tokenHash),
              eq(authSessions.userId, userId),
              eq(authSessions.expiresAt, expiresAt),
              gt(authSessions.expiresAt, new Date()),
            ))
            .for("share")
            .limit(2);
          assertNativeSessionLive(expiresAtMs);
          if (!Array.isArray(currentSessions) || currentSessions.length !== 1
            || currentSessions[0]?.id !== sessionId || currentSessions[0]?.token !== tokenHash
            || currentSessions[0]?.userId !== userId
            || !(currentSessions[0]?.expiresAt instanceof Date)
            || currentSessions[0].expiresAt.getTime() !== expiresAtMs) {
            throw nativeSessionUnavailable();
          }

          const currentUsers = await tx
            .select({ id: authUsers.id, emailVerified: authUsers.emailVerified })
            .from(authUsers)
            .where(eq(authUsers.id, userId))
            .for("share")
            .limit(2);
          assertNativeSessionLive(expiresAtMs);
          if (!Array.isArray(currentUsers) || currentUsers.length !== 1
            || currentUsers[0]?.id !== userId || currentUsers[0]?.emailVerified !== true) {
            throw nativeSessionUnavailable();
          }
        } catch {
          throw nativeSessionUnavailable();
        }
      };

      return Object.freeze({ userId, authorizeInTransaction });
    } catch {
      throw nativeSessionUnavailable();
    }
  }

  async function resolveSession(request: Request): Promise<BetterAuthSessionResult | null> {
    const headers = new Headers();
    for (const [name, input] of Object.entries(request.headers)) {
      if (Array.isArray(input)) headers.set(name, input.join(", "));
      else if (typeof input === "string") headers.set(name, input);
    }
    return resolveSessionFromHeaders(headers);
  }

  const routes = Router();
  routes.post("/session", async (request, response) => {
    const accessToken = headerToken(request);
    if (!accessToken) {
      response.status(401).json({ error: "SPS Identity bearer token is required." });
      return;
    }
    try {
      const { profile, token, expiresInSeconds } = await exchangeSession(accessToken, {
        ipAddress: request.ip || null, userAgent: request.header("user-agent") || null,
      });
      setSessionCookie(response, token, config);
      response.status(201).json({
        account: { email: profile.email, name: profile.name },
        expiresInSeconds,
      });
    } catch (error) {
      response.status(401).json({
        error: error instanceof Error ? error.message : "SPS Identity sign-in failed.",
      });
    }
  });
  routes.post("/logout", async (request, response) => {
    const rawToken = sessionTokenFromHeaders(new Headers({ cookie: request.header("cookie") ?? "" }));
    if (rawToken) {
      await db.delete(authSessions).where(eq(authSessions.token, sha256(rawToken)));
    }
    clearSessionCookie(response, config);
    response.status(204).end();
  });

  return {
    routes,
    resolveSession,
    resolveSessionFromHeaders,
    resolveNativeEnrollmentSessionFromHeaders,
    verifyAccessToken,
    exchangeSession,
  };
}
