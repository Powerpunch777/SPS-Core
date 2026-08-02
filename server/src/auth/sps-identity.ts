import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import { authSessions, authUsers } from "../compat/paperclip/db.js";
import type { Config } from "../config.js";
import type { BetterAuthSessionResult } from "./better-auth.js";

const SESSION_COOKIE = "sps_identity_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

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

  async function upsertUser(profile: IdentityProfile): Promise<string> {
    const userId = localUserId(profile.subject);
    const now = new Date();
    await db
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

  async function createSession(profile: IdentityProfile, request: Request): Promise<string> {
    const userId = await upsertUser(profile);
    const rawToken = randomBytes(48).toString("base64url");
    const now = new Date();
    await db.insert(authSessions).values({
      id: `sps_identity_${randomBytes(18).toString("base64url")}`,
      token: sha256(rawToken),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      createdAt: now,
      updatedAt: now,
      ipAddress: request.ip || null,
      userAgent: request.header("user-agent") || null,
    });
    return rawToken;
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
      const profile = await verifyAccessToken(accessToken);
      const sessionToken = await createSession(profile, request);
      setSessionCookie(response, sessionToken, config);
      response.status(201).json({
        account: { email: profile.email, name: profile.name },
        expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
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

  return { routes, resolveSession, resolveSessionFromHeaders, verifyAccessToken };
}
