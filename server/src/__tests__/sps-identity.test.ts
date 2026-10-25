import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authSessions, authUsers, companyMemberships, createDb } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const issuer = "https://auth.example.test";
const audience = "sps-core";
const keyId = "test-sps-identity-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAccessToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: `google-${randomUUID()}`,
    email: "owner@example.test",
    name: "SPS Owner",
    scope: "sps.core.session",
    exp: now + 60,
    ...overrides,
  }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function createConfig(): Config {
  return {
    authIdentityEnabled: true,
    authIdentityIssuer: issuer,
    authIdentityAudience: audience,
    authIdentityJwksUrl: `${issuer}/.well-known/jwks.json`,
    authPublicBaseUrl: "http://127.0.0.1:31310",
  } as Config;
}

function firstCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("Expected SPS Identity session cookie.");
  return value.split(";", 1)[0]!;
}

async function signIn(app: ReturnType<typeof express>, token = createAccessToken()) {
  const response = await request(app)
    .post("/api/sps-identity/session")
    .set("Authorization", `Bearer ${token}`)
    .send({});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return firstCookie(response);
}

async function expectNativeSessionUnavailable(operation: Promise<unknown>) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("SPS Identity session is unavailable.");
  expect((failure as Error).cause).toBeUndefined();
}

describeEmbeddedPostgres("SPS Identity Core bridge", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-identity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await db.delete(authSessions);
    await db.delete(authUsers).where(eq(authUsers.email, "owner@example.test"));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await tempDb?.cleanup();
  });

  function createApp() {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kty: "RSA", kid: keyId, alg: "RS256", use: "sig" }],
    }), { status: 200 })) as typeof fetch;
    const identity = createSpsIdentityAuth(db, createConfig());
    const app = express();
    app.use(express.json());
    app.use("/api/sps-identity", identity.routes);
    return { app, identity };
  }

  it("creates a Core-only HTTP-only session from a valid SPS Identity access token", async () => {
    const { app, identity } = createApp();
    const subject = `native-host-owner-${randomUUID()}`;
    const response = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken({ sub: subject })}`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.account).toEqual({ email: "owner@example.test", name: "SPS Owner" });
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("sps_identity_session="),
    ]));
    expect(firstCookie(response)).toContain("sps_identity_session=");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");

    const session = await identity.resolveSessionFromHeaders(new Headers({ cookie: firstCookie(response) }));
    expect(session?.user).toMatchObject({
      // Desktop binds Native local management to this private Core identity mapping.
      id: `sps_identity_${createHash("sha256").update(subject).digest("base64url")}`,
      email: "owner@example.test", name: "SPS Owner",
    });
  });

  it("rejects a token that lacks the Core session scope", async () => {
    const { app } = createApp();
    const response = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken({ scope: "openid profile email" })}`)
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("not valid for this Core");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("removes the Core session on logout", async () => {
    const { app, identity } = createApp();
    const signedIn = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken()}`)
      .send({});
    const cookie = firstCookie(signedIn);

    const loggedOut = await request(app)
      .post("/api/sps-identity/logout")
      .set("Cookie", cookie)
      .send({});
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.headers["set-cookie"][0]).toContain("sps_identity_session=;");
    await expect(identity.resolveSessionFromHeaders(new Headers({ cookie }))).resolves.toBeNull();
  });

  it("returns a frozen session-bound authorizer for a verified user without Workspace membership", async () => {
    const { app, identity } = createApp();
    const token = createAccessToken({ sub: `native-owner-${randomUUID()}` });
    const cookie = await signIn(app, token);
    const otherCookie = await signIn(app, createAccessToken({ sub: `native-other-${randomUUID()}` }));
    const other = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie: otherCookie }));
    const nativeSession = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      cookie,
      authorization: `Bearer ${token}`,
      "x-user-id": other.userId,
    }));

    expect(nativeSession.userId).not.toBe(other.userId);
    expect(Object.keys(nativeSession).sort()).toEqual(["authorizeInTransaction", "userId"]);
    expect(Object.isFrozen(nativeSession)).toBe(true);
    expect(JSON.stringify(nativeSession)).not.toContain(cookie.split("=", 2)[1]);
    expect(await db.select({ id: companyMemberships.id }).from(companyMemberships)
      .where(eq(companyMemberships.principalId, nativeSession.userId))).toEqual([]);
    await db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId));
    await db.transaction(tx => other.authorizeInTransaction(tx, other.userId));
    await expectNativeSessionUnavailable(db.transaction(tx =>
      nativeSession.authorizeInTransaction(tx, other.userId)));

    const [session] = await db.select({ id: authSessions.id }).from(authSessions)
      .where(eq(authSessions.userId, nativeSession.userId));
    await db.delete(authSessions).where(eq(authSessions.id, session!.id));
    await expectNativeSessionUnavailable(db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId)));
    await db.transaction(tx => other.authorizeInTransaction(tx, other.userId));
    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      authorization: `Bearer ${token}`,
      "x-user-id": nativeSession.userId,
    })));
  });

  it("rejects a captured authorizer after the same token hash is moved to a new session ID", async () => {
    const { app, identity } = createApp();
    const cookie = await signIn(app, createAccessToken({ sub: `native-session-replaced-${randomUUID()}` }));
    const nativeSession = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
    const [original] = await db.select({
      id: authSessions.id,
      token: authSessions.token,
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
    }).from(authSessions).where(eq(authSessions.userId, nativeSession.userId));
    expect(original).toBeDefined();

    await db.delete(authSessions).where(eq(authSessions.id, original!.id));
    await db.insert(authSessions).values({
      id: `sps_identity_replacement_${randomUUID()}`,
      token: createHash("sha256").update(cookie.slice("sps_identity_session=".length)).digest("base64url"),
      userId: original!.userId,
      expiresAt: original!.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    });

    const replacement = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
    expect(replacement.userId).toBe(nativeSession.userId);
    await db.transaction(tx => replacement.authorizeInTransaction(tx, replacement.userId));
    await expectNativeSessionUnavailable(db.transaction(tx =>
      nativeSession.authorizeInTransaction(tx, nativeSession.userId)));
  });

  it("rejects missing, duplicate, malformed, and overlong native session cookies uniformly", async () => {
    const { identity } = createApp();
    const token = "a".repeat(64);
    const cookie = `sps_identity_session=${token}`;

    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      authorization: "Bearer unrelated-token",
      "x-user-id": "untrusted-user",
    })));
    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      cookie: `${cookie}; ${cookie}`,
    })));
    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      cookie: `sps_identity_session=${"a".repeat(65)}`,
    })));
    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      cookie: `other=${"x".repeat(9_000)}; ${cookie}`,
    })));
  });

  it("rejects an unverified user both at resolution and inside the transaction", async () => {
    const { app, identity } = createApp();
    const cookie = await signIn(app, createAccessToken({ sub: `native-unverified-${randomUUID()}` }));
    const nativeSession = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, nativeSession.userId));

    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie })));
    await expectNativeSessionUnavailable(db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId)));
  });

  it("rechecks session expiry after lookup and refuses expiry changes in an existing transaction guard", async () => {
    const { app, identity } = createApp();
    const cookie = await signIn(app, createAccessToken({ sub: `native-expired-${randomUUID()}` }));
    const nativeSession = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
    const [session] = await db.select({ id: authSessions.id }).from(authSessions)
      .where(eq(authSessions.userId, nativeSession.userId));
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(authSessions.id, session!.id));

    await expectNativeSessionUnavailable(identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie })));
    await expectNativeSessionUnavailable(db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId)));
  });

  it("serializes logout behind the authorizing transaction and rolls back with its caller", async () => {
    const { app, identity } = createApp();
    const cookie = await signIn(app, createAccessToken({ sub: `native-lock-${randomUUID()}` }));
    const nativeSession = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));

    await expect(db.transaction(async tx => {
      await nativeSession.authorizeInTransaction(tx, nativeSession.userId);
      await tx.delete(authSessions).where(eq(authSessions.userId, nativeSession.userId));
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    await db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId));

    let releaseTransaction!: () => void;
    let markAuthorized!: () => void;
    const holdTransaction = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const authorized = new Promise<void>(resolve => { markAuthorized = resolve; });
    const transaction = db.transaction(async tx => {
      await nativeSession.authorizeInTransaction(tx, nativeSession.userId);
      markAuthorized();
      await holdTransaction;
    });
    await authorized;

    let logoutFinished = false;
    const logout = request(app).post("/api/sps-identity/logout").set("Cookie", cookie).send({})
      .then(response => {
        logoutFinished = true;
        return response;
      });
    await new Promise(resolve => setTimeout(resolve, 100));
    const logoutWaitedForTransaction = !logoutFinished;
    releaseTransaction();
    await transaction;
    const response = await logout;

    expect(logoutWaitedForTransaction).toBe(true);
    expect(response.status).toBe(204);
    await expectNativeSessionUnavailable(db.transaction(tx => nativeSession.authorizeInTransaction(tx, nativeSession.userId)));
  });

  it("normalizes database failures without leaking the underlying error", async () => {
    const brokenIdentity = createSpsIdentityAuth({
      select() { throw new Error("sensitive database detail"); },
    } as never, createConfig());
    const error = await brokenIdentity.resolveNativeEnrollmentSessionFromHeaders(new Headers({
      cookie: `sps_identity_session=${"a".repeat(64)}`,
    })).catch(value => value as Error);

    expect(error.message).toBe("SPS Identity session is unavailable.");
    expect(error.message).not.toContain("sensitive database detail");
    expect(error.cause).toBeUndefined();
  });
});
