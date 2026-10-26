import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authSessions,
  authUsers,
  companyMemberships,
  createDb,
  plugins,
  principalPermissionGrants,
  spsMemberDevices,
  spsNativePairings,
} from "@paperclipai/db";
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
const keyId = "test-sps-identity-exchange-key";
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: wrongPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAccessToken(overrides: Record<string, unknown> = {}, signer = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: `exchange-${randomUUID()}`,
    email: "owner@example.test",
    name: "SPS Owner",
    scope: "sps.core.session",
    exp: now + 60,
    ...overrides,
  }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), signer).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function createConfig(authPublicBaseUrl = "http://127.0.0.1:31310"): Config {
  return {
    authIdentityEnabled: true,
    authIdentityIssuer: issuer,
    authIdentityAudience: audience,
    authIdentityJwksUrl: `${issuer}/.well-known/jwks.json`,
    authPublicBaseUrl,
  } as Config;
}

function localUserId(subject: string) {
  return `sps_identity_${createHash("sha256").update(subject).digest("base64url")}`;
}

function cookieHeader(response: request.Response) {
  const value = response.headers["set-cookie"]?.[0];
  if (!value) throw new Error("Expected SPS Identity session cookie.");
  return value;
}

function cookieValue(response: request.Response) {
  return cookieHeader(response).split(";", 1)[0]!;
}

describeEmbeddedPostgres("SPS Identity session exchange", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-identity-exchange-");
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

  function createHub(authPublicBaseUrl?: string, jwksStatus = 200, database: Db = db) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kty: "RSA", kid: keyId, alg: "RS256", use: "sig" }],
    }), { status: jwksStatus })) as typeof fetch;
    const identity = createSpsIdentityAuth(database, createConfig(authPublicBaseUrl));
    const hub = express();
    hub.use(express.json());
    hub.use("/api/sps-identity", identity.routes);
    return { hub, identity };
  }

  async function capabilityState(userId: string) {
    return {
      agents: await db.select({ id: agents.id }).from(agents),
      plugins: await db.select({ id: plugins.id }).from(plugins),
      memberships: await db.select({ id: companyMemberships.id }).from(companyMemberships)
        .where(eq(companyMemberships.principalId, userId)),
      grants: await db.select({ id: principalPermissionGrants.id }).from(principalPermissionGrants)
        .where(eq(principalPermissionGrants.principalId, userId)),
      devices: await db.select({ id: spsMemberDevices.id }).from(spsMemberDevices)
        .where(eq(spsMemberDevices.ownerUserId, userId)),
      pairings: await db.select({ id: spsNativePairings.id }).from(spsNativePairings)
        .where(eq(spsNativePairings.issuedByUserId, userId)),
    };
  }

  async function expectNoAuthRows(userId: string) {
    await expect(db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId))).resolves.toEqual([]);
    await expect(db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId))).resolves.toEqual([]);
  }

  it("exchanges directly into the mapped Core user and stores only a seven-day token hash", async () => {
    const { identity } = createHub();
    const subject = `direct-${randomUUID()}`;
    const userId = localUserId(subject);
    const before = await capabilityState(userId);
    const result = await identity.exchangeSession(createAccessToken({ sub: subject }), {
      ipAddress: "192.0.2.10", userAgent: "session-exchange-test/1",
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.profile)).toBe(true);
    expect(result.profile).toEqual({ subject, email: "owner@example.test", name: "SPS Owner", picture: null });
    expect(result.expiresInSeconds).toBe(sessionTtlMs / 1000);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    const [session] = await db.select().from(authSessions).where(eq(authSessions.userId, userId));
    expect(user).toMatchObject({ id: userId, emailVerified: true, email: "owner@example.test" });
    expect(session).toMatchObject({
      userId, token: createHash("sha256").update(result.token).digest("base64url"),
      ipAddress: "192.0.2.10", userAgent: "session-exchange-test/1",
    });
    expect(session!.token).not.toBe(result.token);
    expect(session!.expiresAt.getTime() - session!.createdAt.getTime()).toBe(sessionTtlMs);
    expect(await capabilityState(userId)).toEqual(before);
  });

  it("keeps regular Hub cookie attributes scheme-bound and logout invalidates the exchanged cookie", async () => {
    for (const [baseUrl, secure] of [["http://127.0.0.1:31310", false], ["https://hub.example.test", true]] as const) {
      const { hub, identity } = createHub(baseUrl);
      const subject = `hub-${randomUUID()}`;
      const userId = localUserId(subject);
      const before = await capabilityState(userId);
      const response = await request(hub).post("/api/sps-identity/session")
        .set("Authorization", `Bearer ${createAccessToken({ sub: subject })}`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.expiresInSeconds).toBe(sessionTtlMs / 1000);
      const setCookie = cookieHeader(response);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie.toLowerCase().includes("; secure")).toBe(secure);

      const cookie = cookieValue(response);
      const session = await identity.resolveSessionFromHeaders(new Headers({ cookie }));
      expect(session?.user?.id).toBe(userId);
      const [stored] = await db.select().from(authSessions).where(eq(authSessions.userId, userId));
      expect(stored!.token).toBe(createHash("sha256").update(cookie.slice("sps_identity_session=".length)).digest("base64url"));
      expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(sessionTtlMs);
      expect(await capabilityState(userId)).toEqual(before);

      await request(hub).post("/api/sps-identity/logout").set("Cookie", cookie).send({}).expect(204);
      await expect(identity.resolveSessionFromHeaders(new Headers({ cookie }))).resolves.toBeNull();
    }
  });

  it("rejects invalid scope, issuer, audience, signature, expiry, nbf, and unavailable JWKS without rows or cookies", async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalid = [
      ["scope", createAccessToken({ scope: "openid profile" }), 200],
      ["issuer", createAccessToken({ iss: "https://wrong.example.test" }), 200],
      ["audience", createAccessToken({ aud: "other-core" }), 200],
      ["signature", createAccessToken({}, wrongPrivateKey), 200],
      ["expiry", createAccessToken({ exp: now - 1 }), 200],
      ["nbf", createAccessToken({ nbf: now + 60 }), 200],
      ["JWKS", createAccessToken(), 503],
    ] as const;

    for (const [label, token, jwksStatus] of invalid) {
      const { hub, identity } = createHub(undefined, jwksStatus);
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sub: string };
      const userId = localUserId(payload.sub);
      const before = await capabilityState(userId);
      await expect(identity.exchangeSession(token, { ipAddress: null, userAgent: null })).rejects.toThrow();
      const response = await request(hub).post("/api/sps-identity/session")
        .set("Authorization", `Bearer ${token}`).send({});
      expect(response.status, label).toBe(401);
      expect(response.headers["set-cookie"], label).toBeUndefined();
      await expectNoAuthRows(userId);
      expect(await capabilityState(userId)).toEqual(before);
    }
  });

  it("rolls back at every pre-commit guard checkpoint, including cancellation after both writes", async () => {
    const { identity } = createHub();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    for (const checkpoint of [1, 2, 3, 4, 5]) {
      const subject = `cancel-${checkpoint}-${randomUUID()}`;
      const userId = localUserId(subject);
      const before = await capabilityState(userId);
      let calls = 0;
      await expect(identity.exchangeSession(createAccessToken({ sub: subject }), { ipAddress: null, userAgent: null }, () => {
        if (++calls === checkpoint) throw new Error("request cancelled");
      })).rejects.toThrow("request cancelled");
      expect(calls).toBe(checkpoint);
      if (checkpoint === 1) expect(fetchMock).not.toHaveBeenCalled();
      await expectNoAuthRows(userId);
      expect(await capabilityState(userId)).toEqual(before);
    }
  });

  it("withholds the result when cancellation is observed after the real transaction commit", async () => {
    let committed = false;
    const committingDb = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") {
          const transact = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
          return async (...args: unknown[]) => {
            const result = await transact.apply(target, args);
            committed = true;
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const { identity } = createHub(undefined, 200, committingDb);
    const subject = `post-commit-${randomUUID()}`;
    const userId = localUserId(subject);
    let guardCalls = 0;

    await expect(identity.exchangeSession(createAccessToken({ sub: subject }), { ipAddress: null, userAgent: null }, () => {
      guardCalls += 1;
      if (committed) throw new Error("request cancelled after commit");
    })).rejects.toThrow("request cancelled after commit");

    expect(committed).toBe(true);
    expect(guardCalls).toBe(6);
    expect(await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId))).toHaveLength(1);
    const sessions = await db.select().from(authSessions).where(eq(authSessions.userId, userId));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
