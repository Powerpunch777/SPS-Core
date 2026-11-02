import { X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsNativeParentIngress } from "../services/sps-native-parent-ingress.js";
import { createSpsNativeMainIngressPeer, getSpsNativeEnrollmentPeerCertificate } from "../services/sps-native-enrollments.js";
import { createMemberTlsFixture } from "./helpers/member-tls.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const UUID = "22222222-2222-4222-8222-222222222222";
const UUID_2 = "33333333-3333-4333-8333-333333333333";
const TOKEN = "a".repeat(64);
const COOKIE = `sps_identity_session=${TOKEN}`;
const PIN = "b".repeat(64);

class Channel extends EventEmitter {
  connected = true;
  messages: unknown[] = [];
  send(message: unknown): boolean { this.messages.push(message); return true; }
  request(operation: string, body: unknown = null, extra: Record<string, unknown> = {}, id = UUID) {
    this.emit("message", { v: 1, kind: "sps.native.parent-ingress.request", id, operation,
      request: { body, transport: { tlsVersion: "TLSv1.3", sessionReused: false, remoteAddress: "127.0.0.1" }, ...extra } });
  }
}

const identityValue = { hostId: HOST_ID, serverSpkiSha256: PIN, issuerSpkiSha256: "c".repeat(64), issuerCertificate: "YWJj" };
const enrollment = (service: Record<string, ReturnType<typeof vi.fn>> = {}) => ({
  identity: identityValue, assertActive: vi.fn(),
  service: { issue: vi.fn(async () => ({ enrollmentId: HOST_ID })),
    completeFromTlsPeer: vi.fn(), reconcileFromTlsPeer: vi.fn(), ...service },
  dispose: vi.fn(),
});
const auth = (overrides: Record<string, unknown> = {}) => ({
  exchangeSession: vi.fn(async () => ({ profile: {}, token: TOKEN, expiresInSeconds: 604800 })),
  resolveNativeEnrollmentSessionFromHeaders: vi.fn(async (headers: Headers) => {
    if (headers.get("cookie") !== COOKIE) return null;
    return { userId: "user-1", authorizeInTransaction: vi.fn(async () => {}) };
  }), ...overrides,
});

const active: Array<{ dispose(): void }> = [];
afterEach(() => { for (const item of active.splice(0)) item.dispose(); });

describe("SPS Native Main-owned parent ingress", () => {
  it("returns only public identity metadata over the private protocol", async () => {
    const channel = new Channel();
    const owner = enrollment();
    active.push(createSpsNativeParentIngress(auth() as never, owner as never, {}, channel as never));
    channel.request("identity");
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    expect(channel.messages[0]).toEqual({ v: 1, kind: "sps.native.parent-ingress.response", id: UUID,
      ok: true, result: identityValue });
  });

  it("resolves the current session from a fixed cookie and runs issue through Core authorization", async () => {
    const channel = new Channel();
    const issue = vi.fn(async () => ({ enrollmentId: HOST_ID }));
    const authorizeInTransaction = vi.fn(async () => {});
    const owner = enrollment({ issue });
    const identity = auth({ resolveNativeEnrollmentSessionFromHeaders: vi.fn(async (headers: Headers) =>
      headers.get("cookie") === COOKIE ? { userId: "user-1", authorizeInTransaction } : null) });
    active.push(createSpsNativeParentIngress(identity as never, owner as never, {}, channel as never));
    channel.request("enrollment.issue", { pairingId: HOST_ID, pairingSecret: "secret", deviceKeyId: HOST_ID,
      requestPem: "-----BEGIN CERTIFICATE REQUEST-----\nYWJj\n-----END CERTIFICATE REQUEST-----\n" },
    { credential: { sessionCookie: COOKIE } });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledWith(new Headers({ cookie: COOKIE }));
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", pairingId: HOST_ID }), expect.any(Function));
    expect(channel.messages[0]).toMatchObject({ ok: true, result: { enrollmentId: HOST_ID } });
  });

  it("dispatches renewal only with its exact DTO, current session and private fresh-TLS peer proof", async () => {
    const peerFixture = await createMemberTlsFixture({ purpose: "clientAuth" });
    try {
      const channel = new Channel();
      const renewed = { renewalId: UUID_2, deviceId: UUID, predecessorCertificateSha256: "d".repeat(64),
        certificate: "AQID", issuerCertificate: "BAUG", certificateNotBefore: "2026-10-27T00:00:00.000Z",
        certificateNotAfter: "2027-01-25T00:00:00.000Z" };
      const renewFromTlsPeer = vi.fn(async (peer: unknown, input: unknown) => {
        expect(getSpsNativeEnrollmentPeerCertificate(peer as never).raw.toString("base64url"))
          .toBe(new X509Certificate(peerFixture.certPem).raw.toString("base64url"));
        expect(input).toEqual({ deviceKeyId: UUID_2, requestPem: "fixture-csr", userId: "user-1" });
        return renewed;
      });
      const owner = { ...enrollment(), renewal: { renewFromTlsPeer } };
      active.push(createSpsNativeParentIngress(auth() as never, owner as never, {}, channel as never));
      const transport = { tlsVersion: "TLSv1.3", sessionReused: false, remoteAddress: "127.0.0.1",
        peerCertificateDer: new X509Certificate(peerFixture.certPem).raw.toString("base64url") };
      channel.request("enrollment.renew", { deviceKeyId: UUID_2, requestPem: "fixture-csr" },
        { credential: { sessionCookie: COOKIE }, transport }, UUID_2);
      await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
      expect(channel.messages[0]).toEqual({ v: 1, kind: "sps.native.parent-ingress.response", id: UUID_2, ok: true, result: renewed });
      expect(renewFromTlsPeer).toHaveBeenCalledTimes(1);

      channel.request("enrollment.renew", { deviceKeyId: UUID_2, requestPem: "fixture-csr", userId: "attacker" },
        { credential: { sessionCookie: COOKIE }, transport }, "44444444-4444-4444-8444-444444444444");
      await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
      expect(channel.messages[1]).toMatchObject({ ok: false, errorCode: "native_ingress_unavailable" });
      channel.request("enrollment.renew", { deviceKeyId: UUID_2, requestPem: "fixture-csr" },
        { credential: { sessionCookie: COOKIE } }, "55555555-5555-4555-8555-555555555555");
      await vi.waitFor(() => expect(channel.messages).toHaveLength(3));
      expect(channel.messages[2]).toMatchObject({ ok: false, errorCode: "native_ingress_unavailable" });
      channel.request("enrollment.renew", { deviceKeyId: UUID_2, requestPem: "fixture-csr" },
        { credential: { sessionCookie: `sps_identity_session=${"z".repeat(64)}` }, transport },
        "77777777-7777-4777-8777-777777777777");
      await vi.waitFor(() => expect(channel.messages).toHaveLength(4));
      expect(channel.messages[3]).toMatchObject({ ok: false, errorCode: "native_ingress_unavailable" });
      expect(renewFromTlsPeer).toHaveBeenCalledTimes(1);
    } finally { await peerFixture.cleanup(); }
  });

  it("rejects malformed envelopes and duplicate IDs without dispatching a Core operation", async () => {
    const channel = new Channel();
    const owner = enrollment();
    active.push(createSpsNativeParentIngress(auth() as never, owner as never, {}, channel as never));
    channel.request("enrollment.issue", null, { credential: { sessionCookie: COOKIE }, extra: true });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    expect(channel.messages[0]).toMatchObject({ ok: false, errorCode: "native_ingress_unavailable" });
    channel.request("identity");
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
    channel.request("identity");
    await vi.waitFor(() => expect(channel.listenerCount("message")).toBe(0));
    expect(channel.messages).toHaveLength(2);
  });

  it("cancels the request fence but keeps the concurrency slot until the operation settles", async () => {
    const channel = new Channel();
    let release!: (value: unknown) => void;
    const identity = auth({ exchangeSession: vi.fn(() => new Promise(resolve => { release = resolve; })) });
    const owner = enrollment();
    const ingress = createSpsNativeParentIngress(identity as never, owner as never, { maxPending: 1 }, channel as never);
    active.push(ingress);
    channel.request("session.exchange", null, { credential: { accessToken: "a.b.c" } });
    await vi.waitFor(() => expect(identity.exchangeSession).toHaveBeenCalled());
    channel.emit("message", { v: 1, kind: "sps.native.parent-ingress.cancel", id: UUID });
    channel.request("identity", null, {}, UUID_2);
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    expect(channel.messages[0]).toMatchObject({ ok: false });
    release({ profile: {}, token: TOKEN, expiresInSeconds: 604800 });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
    expect(channel.messages[1]).toMatchObject({ ok: false });
  });

  it("requires a fresh TLS transport assertion on every operation", async () => {
    const channel = new Channel();
    const owner = enrollment();
    active.push(createSpsNativeParentIngress(auth() as never, owner as never, {}, channel as never));
    channel.emit("message", { v: 1, kind: "sps.native.parent-ingress.request", id: UUID,
      operation: "identity", request: { body: null,
      transport: { tlsVersion: "TLSv1.3", sessionReused: true, remoteAddress: null } } });
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    expect(channel.messages[0]).toMatchObject({ ok: false });
  });

  it("rejects asynchronous Main activity guards before creating peer proof", () => {
    expect(() => createSpsNativeMainIngressPeer({ protocol: "TLSv1.3", resumed: false,
      certificateDer: Buffer.from([0x30, 0x00]),
      assertActive: (() => Promise.reject(new Error("async guard"))) as never })).toThrow();
  });
});
