import { constants, createHash, generateKeyPairSync, randomUUID, sign, X509Certificate } from "node:crypto";
import { createServer, request as httpsRequest, type Server } from "node:https";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authSessions, authUsers, companyMemberships, createDb, spsMemberDeviceEvents,
  spsMemberDevices, spsNativeEnrollments, spsNativePairingEvents, spsNativePairings } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { createSpsNativeSessionEnrollment } from "../services/sps-native-session-enrollment.js";
import { spsNativeEnrollmentService } from "../services/sps-native-enrollments.js";
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
const hostId = randomUUID(), deviceKeyId = randomUUID(), pin = "a".repeat(64);
const policy = { maxTtlMs: 60_000, maxAttempts: 2, maxActiveInvites: 4 };
const hash = (input: string) => createHash("sha256").update(input).digest("hex");

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
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-session-enrollment-");
    db = createDb(database.connectionString);
    member = await createNativeEnrollmentTlsFixture({ hostId, deviceKeyId });
    serverIdentity = await createMemberTlsFixture({ purpose: "serverAuth" });
  }, 60_000);
  afterEach(async () => {
    globalThis.fetch = originalFetch;
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
  });

  async function setup(signing?: (input: { notBefore: number; notAfter: number }) => Promise<string>) {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }))) as typeof fetch;
    const identity = createSpsIdentityAuth(db, { authIdentityEnabled: true, authIdentityIssuer: issuer,
      authIdentityAudience: audience, authIdentityJwksUrl: `${issuer}/.well-known/jwks.json`,
      authPublicBaseUrl: "https://native.example.test" } as Config);
    const loginApp = express(); loginApp.use(express.json()); loginApp.use("/identity", identity.routes);
    async function login(subject: string) {
      const result = await request(loginApp).post("/identity/session").set("Authorization", `Bearer ${token(subject)}`).send({});
      expect(result.status).toBe(201);
      const cookie = result.headers["set-cookie"][0]!.split(";", 1)[0]!;
      const current = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
      if (!current) throw new Error("Fixture session did not resolve");
      return { cookie, userId: current.userId };
    }
    const account = await login("native-member");
    const at = new Date();
    await db.insert(authUsers).values({ id: "native-host", name: "Fixture Host", email: "native-host@example.test", emailVerified: true, createdAt: at, updatedAt: at });
    const pairing = spsNativePairingService(db, hostId, policy, { serverSpkiSha256: pin });
    const invitation = await pairing.issue({ actorUserId: "native-host", target: { kind: "any_verified_user" }, ttlMs: 60_000 });
    let signs = 0;
    const service = spsNativeEnrollmentService(db, { hostId, serverSpkiSha256: pin, issuerCertificate: member.issuerCertificate,
      pairingPolicy: policy, certificateLifetimeMs: 60_000, signingTimeoutMs: 2000, maxConcurrentSignings: 2 }, async input => {
      signs++;
      return { certificate: await (signing ? signing(input) : member.sign(input)), requestSha256: hash(input.requestPem) };
    });
    const facade = createSpsNativeSessionEnrollment(identity, service);
    const server = createServer({ key: serverIdentity.keyPem, cert: serverIdentity.certPem,
      ca: new X509Certificate(Buffer.from(member.issuerCertificate, "base64url")).toString(), requestCert: true,
      rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", secureOptions: constants.SSL_OP_NO_TICKET }, async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const bytes of req) {
          length += bytes.length;
          if (length > 8192) throw new Error("Fixture request too large");
          chunks.push(bytes);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = req.url === "/issue" ? await facade.issue(req, input) : await facade.completeFromTlsRequest(req, input);
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify(result));
      } catch (error) {
        const failure = error as { status?: number; code?: string };
        res.writeHead(failure.status ?? 500, { "Content-Type": "application/json", Connection: "close" }).end(JSON.stringify({ code: failure.code ?? "fixture_failure" }));
      }
    });
    servers.push(server);
    server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
    server.on("tlsClientError", () => {});
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not listen");
    function call(path: string, input: unknown, options: { cookie?: string; certificate?: string; headers?: Record<string, string> } = {}) {
      return new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(input));
        const req = httpsRequest({ hostname: "127.0.0.1", port: (address as { port: number }).port, path,
          method: "POST", agent: false, ca: serverIdentity.certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
          ...(options.certificate ? { cert: new X509Certificate(Buffer.from(options.certificate, "base64url")).toString(), key: member.keyPem } : {}),
          headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length),
            ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers } }, res => {
          const received: Buffer[] = [];
          res.on("data", data => received.push(data));
          res.on("error", reject);
          res.once("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(received).toString("utf8")) }); } catch (error) { reject(error); } });
        });
        req.on("error", reject); req.setTimeout(8000, () => req.destroy(new Error("Fixture HTTPS request timed out"))); req.end(bytes);
      });
    }
    const input = { pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret, deviceKeyId, requestPem: member.requestPem };
    return { facade, input, account, login, loginApp, invitation, call, signs: () => signs };
  }

  it("binds a membership-free session to issuance and fresh mTLS completion without granting access", async () => {
    const value = await setup();
    const issued = await value.call("/issue", value.input, { cookie: value.account.cookie });
    expect(issued.status).toBe(200);
    expect(issued.body.certificate).toEqual(expect.any(String));
    const completed = await value.call("/complete", { pairingId: value.input.pairingId, pairingSecret: value.input.pairingSecret,
      enrollmentId: issued.body.enrollmentId, displayName: "Fixture device" }, { cookie: value.account.cookie, certificate: issued.body.certificate });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ ownerUserId: value.account.userId, status: "pending" });
    expect((await db.select().from(spsMemberDevices))[0]).toMatchObject({ ownerUserId: value.account.userId, status: "pending" });
    expect(await db.select().from(companyMemberships)).toEqual([]);
    expect(value.signs()).toBe(1);
    const [row] = await db.select().from(spsNativePairings);
    expect(row).toMatchObject({ status: "consumed", consumedByUserId: value.account.userId });
    expect(JSON.stringify({ issued, completed })).not.toContain(value.account.cookie);
  });

  it("rejects missing sessions, API-key substitutes, browser origins and body-selected users before signing", async () => {
    const value = await setup();
    for (const options of [{}, { headers: { Authorization: "Bearer fixture-agent-token" } },
      { cookie: "sps_identity_session=fixture-invalid", headers: { "X-SPS-User-Id": value.account.userId } },
      { cookie: value.account.cookie, headers: { Authorization: "Bearer fixture-agent-token" } },
      { cookie: value.account.cookie, headers: { Origin: "https://native.example.test" } },
      { cookie: value.account.cookie, headers: { "Sec-Fetch-Site": "same-origin" } }]) {
      expect((await value.call("/issue", value.input, options)).status).toBe(403);
    }
    expect((await value.call("/issue", { ...value.input, userId: value.account.userId }, { cookie: value.account.cookie })).status).toBe(403);
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
});
