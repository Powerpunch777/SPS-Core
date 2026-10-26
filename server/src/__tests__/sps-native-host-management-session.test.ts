import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { inArray } from "drizzle-orm";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authSessions, authUsers, companyMemberships, companies, createDb, plugins,
  spsMemberDevices, spsNativePairingEvents, spsNativePairings,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import type { SpsIdentityNativeEnrollmentSession } from "../auth/sps-identity.js";
import { createSpsNativeHostManagement } from "../services/sps-native-host-management.js";
import { createSpsNativeHostPairings, SPS_NATIVE_HOST_PAIRING_TTL_MS } from "../services/sps-native-host-pairings.js";
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
const desktopToken = "fixture-desktop-launch-token";
const hostId = "11111111-1111-4111-8111-111111111111";
const serverSpkiSha256 = "a".repeat(64);
const issuerSpkiSha256 = "b".repeat(64);
const issuerCertificate = Buffer.from([0x30, 0x00]).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAccessToken(subject: string, email: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: subject,
    email,
    name: "Native Host Owner",
    scope: "sps.core.session",
    exp: now + 60,
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

function userIdForSubject(subject: string) {
  return `sps_identity_${createHash("sha256").update(subject).digest("base64url")}`;
}

function firstCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("Expected SPS Identity session cookie.");
  return value.split(";", 1)[0]!;
}

async function signIn(app: ReturnType<typeof express>, subject: string, email: string) {
  const response = await request(app)
    .post("/api/sps-identity/session")
    .set("Authorization", `Bearer ${createAccessToken(subject, email)}`)
    .send({});
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return firstCookie(response);
}

class FakeIpcChannel extends EventEmitter {
  connected = true;
  readonly messages: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    const request = message as { id?: string; operation?: string };
    if (request.operation === "inspect" && typeof request.id === "string") {
      queueMicrotask(() => this.emit("message", {
        v: 1,
        kind: "sps.native.signer.response",
        id: request.id,
        ok: true,
        result: { hostId, serverSpkiSha256, issuerSpkiSha256, issuerCertificate },
      }));
    }
    return true;
  }
}

function hostRequest<T extends { set(name: string, value: string): T }>(operation: T, cookie: string) {
  return operation
    .set("Host", "127.0.0.1:31310")
    .set("x-sps-desktop-access", desktopToken)
    .set("x-sps-desktop-owner-bootstrap", desktopToken)
    .set("Cookie", cookie);
}

describeEmbeddedPostgres("SPS Native Host management with SPS Identity sessions", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalFetch = globalThis.fetch;
  const originalDesktopToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
  const userIds: string[] = [];
  const managementInstances: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-native-host-management-session-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const management of managementInstances.splice(0)) management.dispose();
    await db.delete(spsNativePairingEvents);
    await db.delete(spsNativePairings);
    if (userIds.length > 0) {
      await db.delete(authSessions).where(inArray(authSessions.userId, userIds));
      await db.delete(authUsers).where(inArray(authUsers.id, userIds));
      userIds.splice(0);
    }
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    if (originalDesktopToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalDesktopToken;
    await tempDb?.cleanup();
  });

  function createIdentityApp() {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kty: "RSA", kid: keyId, alg: "RS256", use: "sig" }],
    }), { status: 200 })) as typeof fetch;
    const identity = createSpsIdentityAuth(db, createConfig());
    const app = express();
    app.use(express.json());
    app.use("/api/sps-identity", identity.routes);
    app.use(async (req, _res, next) => {
      try {
        const session = await identity.resolveSession(req);
        if (session?.user) {
          req.actor = {
            type: "board",
            source: "session",
            userId: session.user.id,
            isInstanceAdmin: false,
            companyIds: [],
            memberships: [],
          } as Request["actor"];
        }
        next();
      } catch (error) {
        next(error);
      }
    });
    return { app, identity };
  }

  async function createManagement(identity: ReturnType<typeof createSpsIdentityAuth>, ownerUserId: string) {
    process.env.SPS_DESKTOP_ACCESS_TOKEN = desktopToken;
    const channel = new FakeIpcChannel();
    const management = await createSpsNativeHostManagement(identity, { ownerUserId }, channel);
    managementInstances.push(management);
    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0]).toMatchObject({
      v: 1,
      kind: "sps.native.signer.request",
      operation: "inspect",
    });
    return management;
  }

  function mountGuardRoute(app: ReturnType<typeof express>, management: Awaited<ReturnType<typeof createManagement>>) {
    let capturedGuard: SpsIdentityNativeEnrollmentSession | undefined;
    let capturedRequest: Request | undefined;
    app.get("/native/guarded", async (req, res) => {
      capturedRequest = req;
      try {
        const authority = await management.resolveHostSession(req);
        capturedGuard = authority;
        await db.transaction(tx => authority.authorizeInTransaction(tx, authority.userId));
        res.status(200).json({ userId: authority.userId });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error
          && typeof error.status === "number" ? error.status : 500;
        res.status(status).json({ error: error instanceof Error ? error.message : "Request failed." });
      }
    });
    return {
      get guard() { return capturedGuard; },
      get request() { return capturedRequest; },
    };
  }

  async function pairingContext() {
    const subject = `native-pairing-owner-${randomUUID()}`;
    const userId = userIdForSubject(subject);
    userIds.push(userId);
    const { app, identity } = createIdentityApp();
    const cookie = await signIn(app, subject, `owner-${randomUUID()}@example.test`);
    const management = await createManagement(identity, userId);
    // Explicit test-only limits, not approved product defaults.
    const pairings = createSpsNativeHostPairings(db, management, { maxAttempts: 2, maxActiveInvites: 4 });
    const perform = (operation: (req: Request) => Promise<unknown>) => async (req: Request, res: express.Response) => {
      try { res.status(200).json(await operation(req)); }
      catch (error) {
        const status = error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status : 500;
        res.status(status).json({ error: "unavailable" });
      }
    };
    // These test routes are not mounted by Core startup.
    app.post("/native/pairings", perform(req => pairings.issue(req)));
    app.get("/native/pairings", perform(req => pairings.list(req)));
    app.post("/native/pairings/:id/revoke", perform(req => pairings.revoke(req, req.params.id as string)));
    return { app, identity, cookie, management, pairings, userId };
  }

  async function issuePairing(context: Awaited<ReturnType<typeof pairingContext>>) {
    return (await hostRequest(request(context.app).post("/native/pairings"), context.cookie).send({}).expect(200)).body;
  }

  it("resolves the configured Owner, authorizes a real transaction, then rejects after actual logout", async () => {
    const subject = `native-host-owner-${randomUUID()}`;
    const userId = userIdForSubject(subject);
    userIds.push(userId);
    const { app, identity } = createIdentityApp();
    const cookie = await signIn(app, subject, `owner-${randomUUID()}@example.test`);
    const management = await createManagement(identity, userId);
    const captured = mountGuardRoute(app, management);

    const live = await hostRequest(request(app).get("/native/guarded"), cookie).expect(200);
    expect(live.body).toEqual({ userId });
    expect(captured.guard?.userId).toBe(userId);
    expect(captured.request).toBeDefined();
    await expect(db.select().from(companies)).resolves.toEqual([]);
    await expect(db.select().from(companyMemberships)).resolves.toEqual([]);

    const logout = await request(app).post("/api/sps-identity/logout").set("Cookie", cookie).send({}).expect(204);
    expect(logout.headers["set-cookie"][0]).toContain("sps_identity_session=;");
    await expect(db.transaction(tx => captured.guard!.authorizeInTransaction(tx, userId)))
      .rejects.toThrow("SPS Identity session is unavailable.");
    await expect(management.resolveHostSession(captured.request!)).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(companies))).toEqual([]);
    expect((await db.select().from(companyMemberships))).toEqual([]);
  });

  it("denies a different valid signed-in user even when the request actor matches that user's session", async () => {
    const ownerSubject = `native-host-owner-${randomUUID()}`;
    const otherSubject = `native-host-other-${randomUUID()}`;
    const ownerUserId = userIdForSubject(ownerSubject);
    const otherUserId = userIdForSubject(otherSubject);
    userIds.push(ownerUserId, otherUserId);
    const { app, identity } = createIdentityApp();
    const ownerCookie = await signIn(app, ownerSubject, `owner-${randomUUID()}@example.test`);
    const otherCookie = await signIn(app, otherSubject, `other-${randomUUID()}@example.test`);
    const management = await createManagement(identity, ownerUserId);
    const captured = mountGuardRoute(app, management);

    const denied = await hostRequest(request(app).get("/native/guarded"), otherCookie).expect(403);
    expect(denied.body).toEqual({ error: "SPS Native Host management is unavailable." });
    expect(captured.guard).toBeUndefined();
    expect(captured.request?.actor).toMatchObject({ type: "board", source: "session", userId: otherUserId });
    expect(ownerCookie).toContain("sps_identity_session=");
    expect((await db.select().from(companies))).toEqual([]);
    expect((await db.select().from(companyMemberships))).toEqual([]);
  });

  it("issues one-hour any-verified invitations and manages only redacted metadata with zero Agents or Plugins", async () => {
    const context = await pairingContext();
    const issued = await issuePairing(context);
    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "issuedAt", "pairingId", "pairingSecret"]);
    expect(issued.expiresAt - issued.issuedAt).toBe(SPS_NATIVE_HOST_PAIRING_TTL_MS);
    expect(SPS_NATIVE_HOST_PAIRING_TTL_MS).toBe(3_600_000);
    const listed = await hostRequest(request(context.app).get("/native/pairings"), context.cookie).expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: issued.pairingId, status: "pending", target: "any_verified_user",
      issuedByUserId: context.userId, maxAttempts: 2 });
    expect(JSON.stringify(listed.body)).not.toContain(issued.pairingSecret);
    expect((await db.select().from(spsNativePairings))[0]).toMatchObject({ hostId, serverSpkiSha256 });
    await hostRequest(request(context.app).post(`/native/pairings/${issued.pairingId}/revoke`), context.cookie)
      .send({}).expect(200).expect(response => expect(response.body.status).toBe("revoked"));
    expect((await db.select().from(spsNativePairingEvents)).map(row => row.action)).toEqual(["created", "revoked"]);
    for (const table of [agents, plugins, companies, companyMemberships, spsMemberDevices]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  });

  it("rejects another real account and missing Desktop proof without reading or mutating invitations", async () => {
    const context = await pairingContext();
    const issued = await issuePairing(context);
    const otherSubject = `native-pairing-other-${randomUUID()}`;
    userIds.push(userIdForSubject(otherSubject));
    const otherCookie = await signIn(context.app, otherSubject, `other-${randomUUID()}@example.test`);
    await hostRequest(request(context.app).get("/native/pairings"), otherCookie).expect(403);
    await hostRequest(request(context.app).post("/native/pairings"), otherCookie).send({}).expect(403);
    await hostRequest(request(context.app).post(`/native/pairings/${issued.pairingId}/revoke`), otherCookie).send({}).expect(403);
    await request(context.app).get("/native/pairings").set("Host", "127.0.0.1:31310")
      .set("Cookie", context.cookie).set("x-sps-desktop-access", desktopToken).expect(403);
    await hostRequest(request(context.app).get("/native/pairings"), context.cookie)
      .set("Authorization", "Bearer fixture-not-an-owner-session").expect(403);
    expect((await db.select().from(spsNativePairings)).map(row => row.status)).toEqual(["pending"]);
    expect((await db.select().from(spsNativePairingEvents)).map(row => row.action)).toEqual(["created"]);
  });

  it.each(["issue", "list", "revoke"] as const)("rechecks actual logout after session capture before %s", async operation => {
    const context = await pairingContext();
    const issued = await issuePairing(context);
    const resolve = context.identity.resolveNativeEnrollmentSessionFromHeaders.bind(context.identity);
    vi.spyOn(context.identity, "resolveNativeEnrollmentSessionFromHeaders").mockImplementationOnce(async headers => {
      const session = await resolve(headers);
      await request(context.app).post("/api/sps-identity/logout").set("Cookie", context.cookie).send({}).expect(204);
      return session;
    });
    const attempted = operation === "list" ? request(context.app).get("/native/pairings")
      : request(context.app).post(operation === "issue" ? "/native/pairings" : `/native/pairings/${issued.pairingId}/revoke`);
    await hostRequest(attempted, context.cookie).send({}).expect(403);
    expect((await db.select().from(spsNativePairings)).map(row => row.status)).toEqual(["pending"]);
    expect((await db.select().from(spsNativePairingEvents)).map(row => row.action)).toEqual(["created"]);
  });

  it.each(["issue", "revoke"] as const)("rolls back %s and its audit event when Main authority is lost after writes", async operation => {
    const context = await pairingContext();
    const issued = await issuePairing(context);
    const resolve = context.identity.resolveNativeEnrollmentSessionFromHeaders.bind(context.identity);
    let checks = 0;
    vi.spyOn(context.identity, "resolveNativeEnrollmentSessionFromHeaders").mockImplementationOnce(async headers => {
      const session = await resolve(headers);
      return { userId: session.userId, async authorizeInTransaction(tx, userId) {
        await session.authorizeInTransaction(tx, userId);
        if (++checks === 2) context.management.dispose();
      } };
    });
    const path = operation === "issue" ? "/native/pairings" : `/native/pairings/${issued.pairingId}/revoke`;
    await hostRequest(request(context.app).post(path), context.cookie).send({}).expect(403);
    expect(checks).toBe(2);
    expect((await db.select().from(spsNativePairings)).map(row => row.status)).toEqual(["pending"]);
    expect((await db.select().from(spsNativePairingEvents)).map(row => row.action)).toEqual(["created"]);
  });

  it.each(["issue", "revoke"] as const)("withholds a committed %s result after disconnect without claiming rollback or retrying", async operation => {
    const context = await pairingContext();
    const issued = await issuePairing(context);
    const transaction = db.transaction.bind(db);
    const commit = vi.spyOn(db, "transaction").mockImplementationOnce((async callback => {
      const result = await transaction(callback);
      context.management.dispose();
      return result;
    }) as typeof db.transaction);
    try {
      const path = operation === "issue" ? "/native/pairings" : `/native/pairings/${issued.pairingId}/revoke`;
      await hostRequest(request(context.app).post(path), context.cookie).send({}).expect(503);
      expect(commit).toHaveBeenCalledTimes(1);
      const rows = await db.select().from(spsNativePairings);
      const events = await db.select().from(spsNativePairingEvents);
      expect(rows).toHaveLength(operation === "issue" ? 2 : 1);
      expect(rows.map(row => row.status)).toEqual(operation === "issue" ? ["pending", "pending"] : ["revoked"]);
      expect(events.map(row => row.action)).toEqual(operation === "issue" ? ["created", "created"] : ["created", "revoked"]);
      await hostRequest(request(context.app).post(path), context.cookie).send({}).expect(403);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(await db.select().from(spsNativePairings)).toHaveLength(rows.length);
    } finally { commit.mockRestore(); }
  });

  it("requires explicit bounded caps and rejects hidden or accessor policy fields without evaluating them", async () => {
    const context = await pairingContext();
    let getterCalls = 0;
    const accessor = { get maxAttempts() { getterCalls += 1; return 2; }, maxActiveInvites: 4 };
    for (const policy of [undefined, {}, { maxAttempts: 0, maxActiveInvites: 4 },
      { maxAttempts: 2, maxActiveInvites: 101 }, { maxAttempts: 2, maxActiveInvites: 4, maxTtlMs: 1 },
      { maxAttempts: 2, maxActiveInvites: 4, [Symbol("hidden")]: true }, accessor]) {
      expect(() => createSpsNativeHostPairings(db, context.management, policy as never)).toThrow();
    }
    expect(getterCalls).toBe(0);
    expect(await db.select().from(spsNativePairings)).toEqual([]);
  });
});
