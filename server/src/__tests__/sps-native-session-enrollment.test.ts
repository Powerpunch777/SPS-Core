import { constants, createHash, generateKeyPairSync, randomUUID, sign, X509Certificate } from "node:crypto";
import { createServer, request as httpsRequest, type Server } from "node:https";
import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { checkServerIdentity } from "node:tls";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, plugins, authSessions, authUsers, companyMemberships, createDb, sanitizePostRestoreDatabase, spsMemberDeviceEvents,
  spsMemberDevices, spsNativeEnrollments, spsNativePairingEvents, spsNativePairings } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { createSpsNativeSessionEnrollment } from "../services/sps-native-session-enrollment.js";
import { createSpsNativeEnrollmentRequestHandler } from "../services/sps-native-enrollment-http.js";
import { createSpsNativeSessionExchangeRequestHandler } from "../services/sps-native-session-exchange-http.js";
import { createSpsNativeParentIngress } from "../services/sps-native-parent-ingress.js";
import { createSpsNativeMainIngressPeer, getSpsNativeEnrollmentPeerCertificate,
  spsNativeEnrollmentService } from "../services/sps-native-enrollments.js";
import { spsNativePairingService } from "../services/sps-native-pairings.js";
import { createNativeEnrollmentTlsFixture, type NativeEnrollmentTlsFixture } from "./helpers/native-enrollment-tls.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Native session enrollment unavailable: ${support.reason ?? "unsupported"}`);
const issuer = "https://identity.example.test", audience = "sps-core", kid = "native-session-fixture";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = keys.publicKey.export({ format: "jwk" });
const hostId = randomUUID(), deviceKeyId = randomUUID();
const policy = { maxTtlMs: 60_000, maxAttempts: 2, maxActiveInvites: 4 };
const hash = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

function token(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: subject,
    email: `${subject}@example.test`, name: subject, scope: "sps.core.session", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

describeDatabase("Native enrollment with actual SPS sessions and loopback HTTPS", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let member!: NativeEnrollmentTlsFixture, serverIdentity!: MemberTlsFixture;
  const originalFetch = globalThis.fetch;
  const servers: Server[] = [];
  const handlers: ReturnType<typeof createSpsNativeEnrollmentRequestHandler>[] = [];
  const exchanges: ReturnType<typeof createSpsNativeSessionExchangeRequestHandler>[] = [];
  const parentIngresses: Array<{ dispose(): void }> = [];
  const sockets = new Set<Duplex>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-session-enrollment-");
    db = createDb(database.connectionString);
    member = await createNativeEnrollmentTlsFixture({ hostId, deviceKeyId });
    serverIdentity = await createMemberTlsFixture({ purpose: "serverAuth" });
  }, 180_000);
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const handler of handlers.splice(0)) handler.dispose();
    for (const exchange of exchanges.splice(0)) exchange.dispose();
    for (const ingress of parentIngresses.splice(0)) ingress.dispose();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const server of servers.splice(0)) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.delete(spsNativeEnrollments);
    await db.delete(spsNativePairingEvents);
    await db.delete(spsNativePairings);
    await db.delete(spsMemberDeviceEvents);
    await db.delete(spsMemberDevices);
    await db.delete(companyMemberships);
    await db.delete(authSessions);
    await db.delete(authUsers);
  });
  afterAll(async () => {
    await member?.cleanup();
    await serverIdentity?.cleanup();
    await db?.$client.end();
    await database?.cleanup();
  }, 30_000);

  async function setup(signing?: (input: { notBefore: number; notAfter: number }) => Promise<string>,
    limits: { operationTimeoutMs?: number; maxConcurrentRequests?: number } = {},
    renewal?: { renewFromTlsPeer(peer: unknown, input: unknown, authorize: unknown): Promise<unknown> }) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }))) as typeof fetch;
    const identity = createSpsIdentityAuth(db, { authIdentityEnabled: true, authIdentityIssuer: issuer,
      authIdentityAudience: audience, authIdentityJwksUrl: `${issuer}/.well-known/jwks.json`,
      authPublicBaseUrl: "https://native.example.test" } as Config);
    const serverPin = hash(new X509Certificate(serverIdentity.certPem).publicKey.export({ type: "spki", format: "der" }));
    const issuerPin = hash(new X509Certificate(Buffer.from(member.issuerCertificate, "base64url")).publicKey.export({ type: "spki", format: "der" }));
    const loginApp = express(); loginApp.use(express.json()); loginApp.use("/identity", identity.routes);
    const at = new Date();
    await db.insert(authUsers).values({ id: "native-host", name: "Fixture Host", email: "native-host@example.test", emailVerified: true, createdAt: at, updatedAt: at });
    const pairing = spsNativePairingService(db, hostId, policy, { serverSpkiSha256: serverPin });
    const invitation = await pairing.issue({ actorUserId: "native-host", target: { kind: "any_verified_user" }, ttlMs: 60_000 });
    let signs = 0;
    const service = spsNativeEnrollmentService(db, { hostId, serverSpkiSha256: serverPin, issuerCertificate: member.issuerCertificate,
      pairingPolicy: policy, certificateLifetimeMs: 60_000, signingTimeoutMs: 2000, maxConcurrentSignings: 2 }, async input => {
      signs++;
      return { certificate: await (signing ? signing(input) : member.sign(input)), requestSha256: hash(input.requestPem) };
    });
    const facade = createSpsNativeSessionEnrollment(identity, service, renewal as never);
    const handler = createSpsNativeEnrollmentRequestHandler(facade, {
      maxBodyBytes: 8192, readTimeoutMs: 1000, operationTimeoutMs: 10000, maxConcurrentRequests: 4, ...limits,
    });
    handlers.push(handler);
    const exchange = createSpsNativeSessionExchangeRequestHandler(identity, {
      readTimeoutMs: 1000, operationTimeoutMs: 10000, maxConcurrentRequests: 2,
    });
    exchanges.push(exchange);
    let exchangeRequests = 0;
    const server = createServer({ key: serverIdentity.keyPem, cert: serverIdentity.certPem,
      ca: new X509Certificate(Buffer.from(member.issuerCertificate, "base64url")).toString(), requestCert: true,
      rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", secureOptions: constants.SSL_OP_NO_TICKET }, (req, res) => {
      if (req.url === "/sps-native/v1/session/exchange") { exchangeRequests++; exchange.handle(req, res); }
      else handler.handle(req, res);
    });
    servers.push(server);
    server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
    server.on("tlsClientError", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
    function call(path: string, input: unknown, options: { cookie?: string; certificate?: string; headers?: Record<string, string>; pin?: string } = {}) {
      return new Promise<{ status: number; body: Record<string, string>; headers: IncomingHttpHeaders }>((resolve, reject) => {
        const bytes = path === "/exchange" ? Buffer.alloc(0) : Buffer.from(JSON.stringify(input));
        const route = path === "/exchange" ? "/sps-native/v1/session/exchange"
          : path === "/issue" ? "/sps-native/v1/enrollment/issue" : path === "/complete" ? "/sps-native/v1/enrollment/complete" : path;
        const req = httpsRequest({ hostname: "127.0.0.1", port: (address as { port: number }).port, path: route,
          method: "POST", agent: false, ca: serverIdentity.certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
          checkServerIdentity(host, certificate) {
            const failure = checkServerIdentity(host, certificate);
            if (failure) return failure;
            if (hash(new X509Certificate(certificate.raw).publicKey.export({ type: "spki", format: "der" })) !== (options.pin ?? serverPin)) {
              return new Error("Fixture Native server pin mismatch");
            }
            return undefined;
          },
          ...(options.certificate ? { cert: new X509Certificate(Buffer.from(options.certificate, "base64url")).toString(), key: member.keyPem } : {}),
          headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length),
            ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers } }, res => {
          const received: Buffer[] = [];
          res.on("data", data => received.push(data));
          res.on("error", reject);
          res.once("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(received).toString("utf8")), headers: res.headers }); } catch (error) { reject(error); } });
        });
        req.on("error", reject); req.setTimeout(8000, () => req.destroy(new Error("Fixture HTTPS request timed out"))); req.end(bytes);
      });
    }
    async function login(subject: string) {
      const result = await call("/exchange", null, { headers: { Authorization: `Bearer ${token(subject)}` } });
      expect(result.status).toBe(201);
      const fullCookie = result.headers["set-cookie"]?.[0];
      expect(fullCookie).toContain("Secure");
      expect(fullCookie).toContain("HttpOnly");
      expect(result.body).toEqual({ expiresInSeconds: 604800 });
      const cookie = fullCookie!.split(";", 1)[0]!;
      const current = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
      return { cookie, userId: current.userId };
    }
    // A failed server-pin check must happen before HTTP authorization reaches
    // even this local fixture. This is not a production Main client proof.
    const countBefore = exchangeRequests;
    await expect(call("/exchange", null, { pin: "0".repeat(64), headers: { Authorization: `Bearer ${token("wrong-pin")}` } }))
      .rejects.toThrow("Fixture Native server pin mismatch");
    expect(exchangeRequests).toBe(countBefore);
    expect(await db.select().from(authSessions)).toEqual([]);
    const account = await login("native-member");
    const input = { pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret, deviceKeyId, requestPem: member.requestPem };
    return { facade, identity, service, input, account, login, loginApp, invitation, call, serverPin, issuerPin, signs: () => signs };
  }

  it("runs Main-owned nested IPC requests through real sessions, issuance and current-certificate completion", async () => {
    const value = await setup();
    expect(() => createSpsNativeMainIngressPeer({ protocol: "TLSv1.3", resumed: false,
      certificateDer: new X509Certificate(member.certPem).raw,
      assertActive: (() => Promise.reject(new Error("async guards are not accepted"))) as never })).toThrow();
    const { EventEmitter } = await import("node:events");
    class Ipc extends EventEmitter {
      connected = true;
      messages: unknown[] = [];
      send(message: unknown) { this.messages.push(message); return true; }
    }
    const ipc = new Ipc();
    const parentEnrollment = {
      identity: { hostId, serverSpkiSha256: value.serverPin, issuerSpkiSha256: value.issuerPin,
        issuerCertificate: member.issuerCertificate },
      service: value.service,
      assertActive() {},
      dispose() {},
    };
    const ingress = createSpsNativeParentIngress(value.identity as never, parentEnrollment as never, {}, ipc as never);
    parentIngresses.push(ingress);
    const send = async (operation: string, body: unknown, request: Record<string, unknown>, id = randomUUID()) => {
      ipc.emit("message", { v: 1, kind: "sps.native.parent-ingress.request", id, operation,
        request: { body, transport: { tlsVersion: "TLSv1.3", sessionReused: false,
          remoteAddress: "127.0.0.1", ...(operation.endsWith("complete") || operation.endsWith("reconcile")
            ? { peerCertificateDer: request.peerCertificateDer } : {}) },
          ...(Object.hasOwn(request, "peerCertificateDer") ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== "peerCertificateDer")) : request) } });
      await vi.waitFor(() => expect(ipc.messages.length).toBeGreaterThan(0));
      const index = ipc.messages.findIndex((message: any) => message && message.id === id);
      if (index < 0) throw new Error("Missing response for private ingress request");
      return ipc.messages.splice(index, 1)[0] as { ok: boolean; result?: any };
    };
    const issued = await send("enrollment.issue", value.input, { credential: { sessionCookie: value.account.cookie } });
    expect(issued.ok).toBe(true);
    expect(issued.result).toMatchObject({ enrollmentId: expect.any(String), certificate: expect.any(String) });
    const certificateDer = Buffer.from(issued.result.certificate, "base64url");
    const completed = await send("enrollment.complete", { pairingId: value.input.pairingId,
      pairingSecret: value.input.pairingSecret, enrollmentId: issued.result.enrollmentId, displayName: "IPC fixture" },
    { credential: { sessionCookie: value.account.cookie }, peerCertificateDer: certificateDer.toString("base64url") });
    expect(completed).toMatchObject({ ok: true, result: { deviceId: expect.any(String), status: "pending" } });
    expect((await db.select().from(spsMemberDevices)).map(device => device.ownerUserId)).toEqual([value.account.userId]);

    const otherAccount = await value.login("native-member-other-account");
    const denied = await send("enrollment.reconcile", { enrollmentId: issued.result.enrollmentId },
      { credential: { sessionCookie: otherAccount.cookie }, peerCertificateDer: certificateDer.toString("base64url") });
    expect(denied.ok).toBe(false);
    expect((await db.select().from(spsNativePairingEvents)).filter(event => event.action === "consumed")).toHaveLength(1);
  });

  it("binds a membership-free session to issuance and fresh mTLS completion without granting access", async () => {
    const value = await setup();
    expect(await db.select().from(agents)).toEqual([]);
    expect(await db.select().from(plugins)).toEqual([]);
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    expect(issued.body.certificate).toEqual(expect.any(String));
    const completed = await value.call("/complete", { pairingId: value.input.pairingId, pairingSecret: value.input.pairingSecret,
      enrollmentId: issued.body.enrollmentId, displayName: "Fixture device" }, { cookie: value.account.cookie, certificate: issued.body.certificate });
    expect(completed.status).toBe(200);
    expect(completed.body).toEqual({ deviceId: expect.any(String), status: "pending" });
    expect((await db.select().from(spsMemberDevices))[0]).toMatchObject({ ownerUserId: value.account.userId, status: "pending" });
    expect(await db.select().from(companyMemberships)).toEqual([]);
    expect(await db.select().from(agents)).toEqual([]);
    expect(await db.select().from(plugins)).toEqual([]);
    expect(value.signs()).toBe(1);
    const [row] = await db.select().from(spsNativePairings);
    expect(row).toMatchObject({ status: "consumed", consumedByUserId: value.account.userId });
    expect(JSON.stringify({ issued, completed })).not.toContain(value.account.cookie);
  });

  it("binds renewal to the current SPS cookie and the actual presented fresh TLS peer", async () => {
    let expectedCertificate = "";
    let expectedUserId = "";
    const renewFromTlsPeer = vi.fn(async (peer: unknown, input: unknown) => {
      const certificate = getSpsNativeEnrollmentPeerCertificate(peer as never);
      expect(certificate.raw.toString("base64url")).toBe(expectedCertificate);
      expect(input).toMatchObject({ deviceKeyId, requestPem: expect.any(String), userId: expectedUserId });
      return { renewalId: "55555555-5555-4555-8555-555555555555",
        deviceId: "66666666-6666-4666-8666-666666666666", predecessorCertificateSha256: "a".repeat(64),
        certificate: expectedCertificate, issuerCertificate: member.issuerCertificate,
        certificateNotBefore: "2026-10-27T00:00:00.000Z", certificateNotAfter: "2027-01-25T00:00:00.000Z" };
    });
    const value = await setup(undefined, {}, { renewFromTlsPeer });
    expectedUserId = value.account.userId;
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    expectedCertificate = issued.body.certificate;
    const route = "/sps-native/v1/enrollment/renew";
    const body = { deviceKeyId, requestPem: value.input.requestPem };
    const renewed = await value.call(route, body, { cookie: value.account.cookie, certificate: expectedCertificate });
    expect(renewed.status).toBe(200);
    expect(renewFromTlsPeer).toHaveBeenCalledTimes(1);
    expect(renewed.body).toMatchObject({ renewalId: expect.any(String), deviceId: expect.any(String) });
    expect(renewed.headers["set-cookie"]).toBeUndefined();
    expect((await value.call(route, body, { certificate: expectedCertificate })).status).toBe(403);
    expect((await value.call(route, body, { cookie: value.account.cookie })).status).toBe(409);
    expect((await value.call(route, { ...body, userId: value.account.userId },
      { cookie: value.account.cookie, certificate: expectedCertificate })).status).toBe(400);
    expect(renewFromTlsPeer).toHaveBeenCalledTimes(2);
  });

  it("reconciles consumed registration over the actual session and fresh mTLS without replaying an invitation", async () => {
    const value = await setup();
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    const completed = await value.call("/complete", { pairingId: value.input.pairingId,
      pairingSecret: value.input.pairingSecret, enrollmentId: issued.body.enrollmentId, displayName: "Fixture device" },
    { cookie: value.account.cookie, certificate: issued.body.certificate });
    expect(completed.status).toBe(200);
    const route = "/sps-native/v1/enrollment/reconcile";
    const body = { enrollmentId: issued.body.enrollmentId };
    const options = { cookie: value.account.cookie, certificate: issued.body.certificate };
    const before = JSON.stringify({ devices: await db.select().from(spsMemberDevices),
      pairings: await db.select().from(spsNativePairings), deviceEvents: await db.select().from(spsMemberDeviceEvents),
      pairingEvents: await db.select().from(spsNativePairingEvents) });
    for (let index = 0; index < 2; index++) {
      const result = await value.call(route, body, options);
      expect(result.status).toBe(200);
      expect(result.body).toEqual(completed.body);
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    expect(JSON.stringify({ devices: await db.select().from(spsMemberDevices),
      pairings: await db.select().from(spsNativePairings), deviceEvents: await db.select().from(spsMemberDeviceEvents),
      pairingEvents: await db.select().from(spsNativePairingEvents) })).toBe(before);
    expect((await value.call(route, body, { certificate: issued.body.certificate })).status).toBe(403);
    expect((await value.call(route, body, { cookie: value.account.cookie })).status).toBe(409);
    const other = await value.login("other-member");
    expect((await value.call(route, body, { cookie: other.cookie, certificate: issued.body.certificate })).status).toBe(409);
    expect((await value.call(route, { ...body, userId: value.account.userId }, options)).status).toBe(400);
    expect((await request(value.loginApp).post("/identity/logout").set("Cookie", value.account.cookie).send({})).status).toBe(204);
    expect((await value.call(route, body, options)).status).toBe(403);
    expect(value.signs()).toBe(1);
    expect(await db.select().from(companyMemberships)).toEqual([]);
  });

  it("cannot recover scrubbed device trust with an old or freshly authenticated session after restore", async () => {
    const value = await setup();
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    const completed = await value.call("/complete", { pairingId: value.input.pairingId,
      pairingSecret: value.input.pairingSecret, enrollmentId: issued.body.enrollmentId, displayName: "Fixture device" },
    { cookie: value.account.cookie, certificate: issued.body.certificate });
    expect(completed.status).toBe(200);
    await sanitizePostRestoreDatabase(database.connectionString);
    const path = "/sps-native/v1/enrollment/reconcile";
    const body = { enrollmentId: issued.body.enrollmentId };
    expect((await value.call(path, body, { cookie: value.account.cookie, certificate: issued.body.certificate })).status).toBe(403);
    const fresh = await value.login("native-member");
    expect(fresh.userId).toBe(value.account.userId);
    expect((await value.call(path, body, { cookie: fresh.cookie, certificate: issued.body.certificate })).status).toBe(409);
    expect(await db.select().from(spsNativeEnrollments)).toEqual([]);
    expect(await db.select().from(spsNativePairings)).toEqual([]);
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
    expect(await db.select().from(companyMemberships)).toEqual([]);
    expect(value.signs()).toBe(1);
  });

  it("rejects missing sessions, API-key substitutes, browser origins and body-selected users before signing", async () => {
    const value = await setup();
    const rejected: NonNullable<Parameters<typeof value.call>[2]>[] = [{}, { headers: { Authorization: "Bearer fixture-agent-token" } },
      { cookie: "sps_identity_session=fixture-invalid", headers: { "X-SPS-User-Id": value.account.userId } },
      { cookie: value.account.cookie, headers: { Authorization: "Bearer fixture-agent-token" } },
      { cookie: value.account.cookie, headers: { Origin: "https://native.example.test" } },
      { cookie: value.account.cookie, headers: { "Sec-Fetch-Site": "same-origin" } }];
    for (const options of rejected) {
      expect((await value.call("/issue", value.input, options)).status).toBe(403);
    }
    expect((await value.call("/issue", { ...value.input, userId: value.account.userId }, { cookie: value.account.cookie })).status).toBe(400);
    const plain = new IncomingMessage(new Socket()); plain.method = "POST";
    await expect(value.facade.issue(plain, value.input)).rejects.toMatchObject({ code: "native_enrollment_request_unavailable" });
    let invoked = false;
    const hostile = Object.defineProperty({ ...value.input }, "requestPem", { enumerable: true, get() { invoked = true; throw new Error("fixture private data"); } });
    await expect(value.facade.issue(plain, hostile)).rejects.toMatchObject({ code: "native_enrollment_request_unavailable" });
    expect(invoked).toBe(false);
    plain.destroy();
    expect(value.signs()).toBe(0);
    expect(await db.select().from(spsNativeEnrollments)).toEqual([]);
    expect((await db.select().from(spsNativePairings))[0]).toMatchObject({ status: "pending", failedAttempts: 0 });
  });

  it("rejects another valid session and missing client certificates for an issued enrollment", async () => {
    const value = await setup();
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    const input = { pairingId: value.input.pairingId, pairingSecret: value.input.pairingSecret,
      enrollmentId: issued.body.enrollmentId, displayName: "Fixture device" };
    const other = await value.login("other-member");
    expect((await value.call("/complete", input, { cookie: other.cookie, certificate: issued.body.certificate })).status).toBe(409);
    expect((await value.call("/complete", input, { cookie: value.account.cookie })).status).toBe(409);
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
    expect((await db.select().from(spsNativePairings))[0]).toMatchObject({ status: "pending" });
  });

  it("does not publish an issuance when the actual Core session logs out during signing", async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const begun = new Promise<void>(resolve => { started = resolve; });
    const value = await setup(async input => { started(); await held; return await member.sign(input); });
    const issuing = value.call("/issue", value.input, { cookie: value.account.cookie });
    try {
      await begun;
      expect((await request(value.loginApp).post("/identity/logout").set("Cookie", value.account.cookie).send({})).status).toBe(204);
      release();
      expect((await issuing).status).toBe(409);
    } finally { release(); await issuing; }
    expect((await db.select().from(spsNativeEnrollments))[0]).toMatchObject({ status: "failed", certificate: null });
    expect((await db.select().from(spsNativePairings))[0]).toMatchObject({ status: "pending", consumedAt: null });
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("fences late issuance after an HTTP deadline and holds capacity until signing actually settles", async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const begun = new Promise<void>(resolve => { started = resolve; });
    const value = await setup(async input => { started(); await held; return await member.sign(input); }, {
      operationTimeoutMs: 500, maxConcurrentRequests: 1,
    });
    const issuing = value.call("/issue", value.input, { cookie: value.account.cookie });
    try {
      await begun;
      expect((await issuing).status).toBe(408);
      expect((await value.call("/issue", value.input, { cookie: value.account.cookie })).status).toBe(429);
      release();
      await vi.waitFor(async () => {
        expect((await db.select().from(spsNativeEnrollments))[0]).toMatchObject({ status: "failed", certificate: null });
      }, { timeout: 4000, interval: 25 });
      expect((await value.call("/issue", value.input, { cookie: value.account.cookie })).status).toBe(409);
      expect(value.signs()).toBe(1);
      expect((await db.select().from(spsNativePairings))[0]).toMatchObject({ status: "pending", consumedAt: null });
      expect(await db.select().from(spsMemberDevices)).toEqual([]);
    } finally { release(); await issuing; }
  });
});
