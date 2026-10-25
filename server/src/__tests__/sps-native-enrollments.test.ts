import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createServer, connect, type TLSSocket } from "node:tls";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers, companyMemberships, createDb, spsMemberDeviceEvents, spsMemberDevices,
  spsNativeEnrollments, spsNativePairingEvents, spsNativePairings,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createNativeEnrollmentTlsFixture, type NativeEnrollmentTlsFixture } from "./helpers/native-enrollment-tls.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { spsNativePairingService } from "../services/sps-native-pairings.js";
import { spsNativeEnrollmentService, type SpsNativeEnrollmentSigner } from "../services/sps-native-enrollments.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Native enrollment database tests unavailable: ${support.reason ?? "unsupported"}`);
const POLICY = { maxTtlMs: 60_000, maxAttempts: 2, maxActiveInvites: 4 };
const PIN = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describeDatabase("Native invitation-bound issuance and live mTLS completion", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const fixtures: Array<NativeEnrollmentTlsFixture | MemberTlsFixture> = [];
  const socketCleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-enrollments-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    for (const cleanup of socketCleanups.splice(0)) await cleanup();
    for (const fixture of fixtures.splice(0)) await fixture.cleanup();
    await db.delete(spsNativeEnrollments);
    await db.delete(spsNativePairingEvents);
    await db.delete(spsNativePairings);
    await db.delete(spsMemberDeviceEvents);
    await db.delete(spsMemberDevices);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function setup(signOverride?: SpsNativeEnrollmentSigner) {
    const hostId = randomUUID(), deviceKeyId = randomUUID();
    const fixture = await createNativeEnrollmentTlsFixture({ hostId, deviceKeyId }); fixtures.push(fixture);
    const actorUserId = "fixture-host", userId = "fixture-member";
    const at = new Date();
    await db.insert(authUsers).values([
      { id: actorUserId, name: "Fixture Host", email: "fixture-host@example.test", emailVerified: true },
      { id: userId, name: "Fixture Member", email: "fixture-member@example.test", emailVerified: true },
      { id: "other-member", name: "Other", email: "other@example.test", emailVerified: true },
    ].map(row => ({ ...row, createdAt: at, updatedAt: at })));
    const pairing = spsNativePairingService(db, hostId, POLICY, { serverSpkiSha256: PIN });
    const invitation = await pairing.issue({ actorUserId, target: { kind: "any_verified_user" }, ttlMs: 60_000 });
    let signCalls = 0;
    const signing: SpsNativeEnrollmentSigner = async input => {
      signCalls++;
      if (signOverride) return signOverride(input);
      expect(input.hostId).toBe(hostId); expect(input.deviceKeyId).toBe(deviceKeyId);
      expect(input.requestPem).toBe(fixture.requestPem);
      return { certificate: await fixture.sign(input), requestSha256: digest(input.requestPem) };
    };
    const options = {
      hostId, serverSpkiSha256: PIN, issuerCertificate: fixture.issuerCertificate,
      pairingPolicy: POLICY, certificateLifetimeMs: 60_000, signingTimeoutMs: 1000, maxConcurrentSignings: 2,
    };
    const service = spsNativeEnrollmentService(db, options, signing);
    const input = { pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret, userId, deviceKeyId, requestPem: fixture.requestPem };
    return { hostId, fixture, pairing, invitation, service, input, options, signCalls: () => signCalls };
  }
  async function peer(fixture: NativeEnrollmentTlsFixture, certPem: string) {
    const serverIdentity = await createMemberTlsFixture({ purpose: "serverAuth" }); fixtures.push(serverIdentity);
    const sockets = new Set<TLSSocket>();
    const server = createServer({
      key: serverIdentity.keyPem, cert: serverIdentity.certPem,
      ca: new X509Certificate(Buffer.from(fixture.issuerCertificate, "base64url")).toString(), requestCert: true, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    });
    server.on("connection", socket => { socket.on("error", () => {}); sockets.add(socket as TLSSocket); });
    server.on("tlsClientError", () => {});
    const cleanup = async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture TLS cleanup timed out")), 3000);
        server.close(error => { clearTimeout(timer); error ? reject(error) : resolve(); });
      });
    };
    socketCleanups.push(cleanup);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture TLS listen timed out")), 3000);
      server.once("error", error => { clearTimeout(timer); reject(error); });
      server.listen({ host: "127.0.0.1", port: 0 }, () => { clearTimeout(timer); resolve(); });
    });
    return new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture mTLS handshake timed out")), 3000);
      server.once("tlsClientError", error => { clearTimeout(timer); reject(error); });
      server.once("secureConnection", socket => { clearTimeout(timer); resolve(socket); });
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
      const client = connect({ host: "127.0.0.1", port: address.port, ca: serverIdentity.certPem,
        key: fixture.keyPem, cert: certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true });
      sockets.add(client);
      client.on("error", error => { clearTimeout(timer); reject(error); });
    });
  }
  function completion(value: Awaited<ReturnType<typeof setup>>, enrollmentId: string) {
    return { pairingId: value.input.pairingId, pairingSecret: value.input.pairingSecret,
      userId: value.input.userId, enrollmentId, displayName: "Fixture Member PC" };
  }

  it("persists exactly one public issuance and replays it after restart without consuming or granting membership", async () => {
    const value = await setup();
    const issued = await value.service.issue(value.input);
    expect(value.signCalls()).toBe(1);
    expect(await value.service.issue(value.input)).toEqual(issued);
    const restarted = spsNativeEnrollmentService(db, value.options, async () => { throw new Error("Must not sign twice"); });
    expect(await restarted.issue(value.input)).toEqual(issued);
    expect((await value.pairing.listHost())[0]?.status).toBe("pending");
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
    expect(await db.select().from(companyMemberships)).toEqual([]);
    const rows = await db.select().from(spsNativeEnrollments);
    expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe("issued");
    const serialized = JSON.stringify(rows);
    for (const secret of [value.input.pairingSecret, value.fixture.requestPem, value.fixture.keyPem]) expect(serialized).not.toContain(secret);
  });

  it("requires an actual fresh TLS peer then atomically consumes once and registers only pending state", async () => {
    const value = await setup(); const issued = await value.service.issue(value.input);
    await expect(value.service.completeFromTlsPeer({ authorized: true } as TLSSocket, completion(value, issued.enrollmentId)))
      .rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    const socket = await peer(value.fixture, new X509Certificate(Buffer.from(issued.certificate, "base64url")).toString());
    expect(socket.authorized).toBe(true); expect(socket.isSessionReused()).toBe(false);
    await expect(value.service.completeFromTlsPeer(socket, { ...completion(value, issued.enrollmentId), userId: "other-member" }))
      .rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(value.service.completeFromTlsPeer(socket, { ...completion(value, issued.enrollmentId), certificate: issued.certificate } as never))
      .rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    const outcomes = await Promise.allSettled([
      value.service.completeFromTlsPeer(socket, completion(value, issued.enrollmentId)),
      value.service.completeFromTlsPeer(socket, completion(value, issued.enrollmentId)),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const devices = await db.select().from(spsMemberDevices);
    expect(devices).toHaveLength(1); expect(devices[0]?.status).toBe("pending");
    expect(await db.select().from(companyMemberships)).toEqual([]);
    expect((await value.pairing.listHost())[0]?.status).toBe("consumed");
    expect(await db.select().from(spsNativePairingEvents).where(eq(spsNativePairingEvents.action, "consumed"))).toHaveLength(1);
    expect(await db.select().from(spsMemberDeviceEvents)).toHaveLength(1);
  });

  it("rejects another user, request, pin and an unverified account without signing again", async () => {
    const value = await setup(); await value.service.issue(value.input);
    await expect(value.service.issue({ ...value.input, userId: "other-member" })).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(value.service.issue({ ...value.input, requestPem: value.input.requestPem.replace("\n", "\r\n") })).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    const other = spsNativeEnrollmentService(db, { ...value.options, serverSpkiSha256: "b".repeat(64) }, async () => { throw new Error("Unexpected signer"); });
    await expect(other.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await db.update(authUsers).set({ emailVerified: false }).where(eq(authUsers.id, value.input.userId));
    await expect(value.service.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect(value.signCalls()).toBe(1);
  });

  it("commits wrong-secret attempts without allocating an issuance or invoking the signer", async () => {
    const value = await setup(); const input = { ...value.input, pairingSecret: randomBytes(32).toString("base64url") };
    await expect(value.service.issue(input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(value.service.issue(input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect((await value.pairing.listHost())[0]).toMatchObject({ status: "exhausted", failedAttempts: 2 });
    expect(await db.select().from(spsNativeEnrollments)).toEqual([]); expect(value.signCalls()).toBe(0);
  });

  it("does not re-sign after failure, and a signer failure never consumes the invitation", async () => {
    const value = await setup(async () => { throw new Error("fixture-secret-error"); });
    await expect(value.service.issue(value.input)).rejects.toThrow("This SPS device enrollment is unavailable.");
    expect((await db.select().from(spsNativeEnrollments))[0]?.status).toBe("failed");
    await expect(value.service.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect(value.signCalls()).toBe(1); expect((await value.pairing.listHost())[0]?.status).toBe("pending");
  });

  it("serializes reservations across service instances and rejects replacement CSR while signing", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
    const value = await setup(async input => {
      started(); await waiting;
      return { certificate: await value.fixture.sign(input), requestSha256: digest(input.requestPem) };
    });
    const first = value.service.issue(value.input); await begun;
    const second = spsNativeEnrollmentService(db, value.options, async () => { throw new Error("Second instance signed"); });
    await expect(second.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(second.issue({ ...value.input, deviceKeyId: randomUUID() })).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    release(); await first; expect(value.signCalls()).toBe(1);
  });

  it("withholds signed output when invitation is revoked during the asynchronous signer", async () => {
    const value = await setup(async input => {
      const certificate = await value.fixture.sign(input);
      await value.pairing.revoke(value.invitation.pairingId, "fixture-host");
      return { certificate, requestSha256: digest(input.requestPem) };
    });
    await expect(value.service.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect((await db.select().from(spsNativeEnrollments))[0]?.status).toBe("failed");
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("rejects the original unissued leaf even on an authorized same-issuer TLS connection", async () => {
    const value = await setup(); const issued = await value.service.issue(value.input);
    const socket = await peer(value.fixture, value.fixture.certPem);
    await expect(value.service.completeFromTlsPeer(socket, completion(value, issued.enrollmentId))).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect((await value.pairing.listHost())[0]?.status).toBe("pending");
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("retains its signing slot after timeout until the ignored-abort signer settles", async () => {
    const value = await setup();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let finished!: () => void; const settled = new Promise<void>(resolve => { finished = resolve; });
    let calls = 0;
    const service = spsNativeEnrollmentService(db, { ...value.options, maxConcurrentSignings: 1 }, async input => {
      calls++;
      try {
        await gate;
        return { certificate: await value.fixture.sign(input), requestSha256: digest(input.requestPem) };
      } finally { finished(); }
    });
    try {
      await expect(service.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
      const invitation = await value.pairing.issue({ actorUserId: "fixture-host", target: { kind: "any_verified_user" }, ttlMs: 60_000 });
      const input = { ...value.input, pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret };
      await expect(service.issue(input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
      expect(calls).toBe(1);
      expect(await db.select().from(spsNativeEnrollments)).toHaveLength(1);
      release();
      await settled;
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(service.issue(input)).resolves.toHaveProperty("enrollmentId");
      expect(calls).toBe(2);
      expect((await db.select().from(spsNativeEnrollments).where(eq(spsNativeEnrollments.pairingId, value.input.pairingId)))[0]?.status).toBe("failed");
    } finally { release(); }
  });

  it("does not revive a revoked key through a fresh invitation and newly issued certificate", async () => {
    const value = await setup(); const first = await value.service.issue(value.input);
    const socket = await peer(value.fixture, new X509Certificate(Buffer.from(first.certificate, "base64url")).toString());
    const device = await value.service.completeFromTlsPeer(socket, completion(value, first.enrollmentId));
    await db.update(spsMemberDevices).set({ status: "revoked", revokedAt: new Date() }).where(eq(spsMemberDevices.id, device.id));
    const invitation = await value.pairing.issue({ actorUserId: "fixture-host", target: { kind: "any_verified_user" }, ttlMs: 60_000 });
    const input = { ...value.input, pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret };
    const next = await value.service.issue(input);
    const nextSocket = await peer(value.fixture, new X509Certificate(Buffer.from(next.certificate, "base64url")).toString());
    await expect(value.service.completeFromTlsPeer(nextSocket, {
      pairingId: invitation.pairingId, pairingSecret: invitation.pairingSecret, userId: value.input.userId,
      enrollmentId: next.enrollmentId, displayName: "Replacement attempt",
    })).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect((await db.select().from(spsMemberDevices))).toHaveLength(1);
    expect((await db.select().from(spsMemberDevices))[0]?.status).toBe("revoked");
    expect((await value.pairing.listHost()).find(row => row.id === invitation.pairingId)?.status).toBe("pending");
  });

  it("rejects a persisted binding changed while signing without overwriting the changed row", async () => {
    const value = await setup(async input => {
      const certificate = await value.fixture.sign(input);
      await db.update(spsNativeEnrollments).set({ userId: "other-member" }).where(eq(spsNativeEnrollments.pairingId, value.input.pairingId));
      return { certificate, requestSha256: digest(input.requestPem) };
    });
    await expect(value.service.issue(value.input)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    const [row] = await db.select().from(spsNativeEnrollments);
    expect(row).toMatchObject({ userId: "other-member", status: "signing", certificate: null, certificateSha256: null });
    expect((await value.pairing.listHost())[0]?.status).toBe("pending");
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("rolls back completion when the leaf expires after the consumed event insert", async () => {
    const { vi } = await import("vitest");
    const value = await setup();
    type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let inserted!: () => void;
    const consumedInserted = new Promise<void>(resolve => { inserted = resolve; });
    const gatedDb = new Proxy(db, {
      get(target, property) {
        if (property !== "transaction") {
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        }
        return (operation: (tx: Transaction) => Promise<unknown>) => target.transaction(tx => operation(new Proxy(tx, {
          get(transaction, key) {
            if (key !== "insert") {
              const member = Reflect.get(transaction, key, transaction);
              return typeof member === "function" ? member.bind(transaction) : member;
            }
            return (table: Parameters<Transaction["insert"]>[0]) => {
              const builder = transaction.insert(table);
              if (table !== spsNativePairingEvents) return builder;
              return new Proxy(builder, {
                get(insert, method) {
                  if (method !== "values") {
                    const member = Reflect.get(insert, method, insert);
                    return typeof member === "function" ? member.bind(insert) : member;
                  }
                  return async (event: typeof spsNativePairingEvents.$inferInsert) => {
                    const result = await insert.values(event);
                    if (event.action === "consumed") {
                      // Pause only after PostgreSQL has written the event in the live transaction.
                      inserted();
                      await gate;
                    }
                    return result;
                  };
                },
              });
            };
          },
        })));
      },
    });
    const service = spsNativeEnrollmentService(gatedDb, { ...value.options, certificateLifetimeMs: 30_000 }, async input => ({
      certificate: await value.fixture.sign(input), requestSha256: digest(input.requestPem),
    }));
    const issued = await service.issue(value.input);
    const certificate = new X509Certificate(Buffer.from(issued.certificate, "base64url"));
    const leafExpiresAt = Date.parse(certificate.validTo);
    expect(leafExpiresAt).toBeLessThan(value.invitation.expiresAt);
    const socket = await peer(value.fixture, certificate.toString());
    const clock = vi.spyOn(Date, "now");
    const outcome = service.completeFromTlsPeer(socket, completion(value, issued.enrollmentId)).then(
      () => ({ fulfilled: true as const }),
      (error: unknown) => ({ fulfilled: false as const, error }),
    );
    try {
      await Promise.race([consumedInserted, outcome.then(() => { throw new Error("Completion did not reach the consumed-event gate"); })]);
      expect(new Date().getTime()).toBeLessThan(value.invitation.expiresAt);
      clock.mockReturnValue(leafExpiresAt);
      release();
      expect(await outcome).toMatchObject({ fulfilled: false, error: { code: "native_enrollment_unavailable" } });
      expect(socket.authorized).toBe(true);
    } finally {
      release();
      await outcome;
      clock.mockRestore();
    }
    const [invitation] = await db.select().from(spsNativePairings).where(eq(spsNativePairings.id, value.invitation.pairingId));
    expect(invitation).toMatchObject({ status: "pending", consumedAt: null, consumedByUserId: null, consumedDeviceId: null, consumedDeviceSnapshotId: null });
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
    expect(await db.select().from(spsMemberDeviceEvents)).toEqual([]);
    expect(await db.select().from(spsNativePairingEvents).where(eq(spsNativePairingEvents.action, "consumed"))).toEqual([]);
    expect(await db.select().from(companyMemberships)).toEqual([]);
  });
});
