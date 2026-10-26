import { EventEmitter } from "node:events";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpsIdentityNativeEnrollmentSession } from "../auth/sps-identity.js";
import { createSpsNativeHostManagement } from "../services/sps-native-host-management.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_USER_ID = "desktop-owner-user";
const OTHER_USER_ID = "different-session-user";
const SERVER_PIN = "a".repeat(64);
const ISSUER_PIN = "b".repeat(64);
const ISSUER_CERTIFICATE = Buffer.from([0x30, 0x00]).toString("base64url");
const DESKTOP_TOKEN = "fixture-desktop-launch-token";
const SESSION_COOKIE = "sps_identity_session=opaque-fixture-session";

class FakeIpcChannel extends EventEmitter {
  connected = true;
  readonly messages: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    return true;
  }

  reply(message: unknown): void {
    this.emit("message", message);
  }
}

type SessionResolver = (headers: Headers) => Promise<SpsIdentityNativeEnrollmentSession>;

function identityWith(resolve: SessionResolver) {
  return {
    resolveNativeEnrollmentSessionFromHeaders: vi.fn(resolve),
  };
}

function sessionFixture(
  userId = ACTOR_USER_ID,
  authorizeInTransaction = vi.fn(async (_tx: unknown, _expectedUserId: string) => {}),
): SpsIdentityNativeEnrollmentSession {
  return Object.freeze({ userId, authorizeInTransaction }) as SpsIdentityNativeEnrollmentSession;
}

function twoDesktopProofs(): Array<[string, string]> {
  return [
    ["x-sps-desktop-access", DESKTOP_TOKEN],
    ["x-sps-desktop-owner-bootstrap", DESKTOP_TOKEN],
  ];
}

type HostRequestOptions = {
  actor?: unknown;
  host?: string;
  remoteAddress?: string;
  proofHeaders?: Array<[string, string]>;
  rawCookies?: string[];
  extraHeaders?: Record<string, string>;
};

function authenticatedHostRequest(options: HostRequestOptions = {}): Request {
  const rawPairs: Array<[string, string]> = [
    ["Host", options.host ?? "127.0.0.1:31310"],
    ...(options.proofHeaders ?? twoDesktopProofs()),
    ...Object.entries(options.extraHeaders ?? {}),
    ...(options.rawCookies ?? [SESSION_COOKIE]).map(cookie => ["Cookie", cookie] as [string, string]),
  ];
  const headers: Record<string, string> = {};
  for (const [name, value] of rawPairs) {
    const key = name.toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return {
    actor: options.actor ?? { type: "board", source: "session", userId: ACTOR_USER_ID },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    headers,
    rawHeaders: rawPairs.flat(),
    header(name: string) { return headers[name.toLowerCase()]; },
  } as never;
}

const active: Array<{ dispose(): void }> = [];
let originalDesktopToken: string | undefined;

beforeEach(() => {
  originalDesktopToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
  process.env.SPS_DESKTOP_ACCESS_TOKEN = DESKTOP_TOKEN;
});

afterEach(() => {
  for (const value of active.splice(0)) value.dispose();
  if (originalDesktopToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
  else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalDesktopToken;
});

async function createManagement(identity: ReturnType<typeof identityWith>, channel = new FakeIpcChannel()) {
  const creation = createSpsNativeHostManagement(identity, { ownerUserId: ACTOR_USER_ID }, channel);
  const inspect = channel.messages[0] as { id: string; operation: string };
  channel.reply({
    v: 1,
    kind: "sps.native.signer.response",
    id: inspect.id,
    ok: true,
    result: {
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      issuerCertificate: ISSUER_CERTIFICATE,
    },
  });
  const management = await creation;
  active.push(management);
  return { channel, management, inspect };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("SPS Native Host management", () => {
  it("binds safe Host metadata to parent inspection and returns a guarded session", async () => {
    const session = sessionFixture();
    const identity = identityWith(async () => session);
    const { channel, management, inspect } = await createManagement(identity);

    expect(inspect).toMatchObject({ v: 1, kind: "sps.native.signer.request", operation: "inspect" });
    expect(channel.messages).toHaveLength(1);
    const metadata = { hostId: management.hostId, serverSpkiSha256: management.serverSpkiSha256,
      issuerSpkiSha256: management.issuerSpkiSha256 };
    expect(metadata).toEqual({ hostId: HOST_ID, serverSpkiSha256: SERVER_PIN, issuerSpkiSha256: ISSUER_PIN });
    expect(Object.keys(management).sort()).toEqual([
      "assertActive", "dispose", "hostId", "issuerSpkiSha256", "resolveHostSession", "serverSpkiSha256",
    ].sort());

    const hostSession = await management.resolveHostSession(authenticatedHostRequest());
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledTimes(1);
    const passedHeaders = identity.resolveNativeEnrollmentSessionFromHeaders.mock.calls[0]![0];
    expect([...passedHeaders.entries()]).toEqual([["cookie", SESSION_COOKIE]]);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(hostSession)).toBe(true);
    expect(hostSession.userId).toBe(ACTOR_USER_ID);

    const tx = {};
    await hostSession.authorizeInTransaction(tx as never, ACTOR_USER_ID);
    expect(session.authorizeInTransaction).toHaveBeenCalledWith(tx, ACTOR_USER_ID);

    const returned = `${JSON.stringify(management)} ${JSON.stringify(hostSession)}`;
    expect(JSON.stringify(management)).toBe(JSON.stringify(metadata));
    expect(returned).toContain(ISSUER_PIN);
    expect(returned).not.toContain(ISSUER_CERTIFICATE);
    expect(returned).not.toContain(DESKTOP_TOKEN);
    expect(returned).not.toContain(SESSION_COOKIE);
    expect(returned).not.toContain("sps.native.signer");
  });

  it.each(["parent refuses inspection", "parent disconnects during inspection"])(
    "fails closed with no automatic enablement when %s",
    async failure => {
      const channel = new FakeIpcChannel();
      const identity = identityWith(async () => sessionFixture());
      const creation = createSpsNativeHostManagement(identity, { ownerUserId: ACTOR_USER_ID }, channel);
      const inspect = channel.messages[0] as { id: string };

      if (failure === "parent refuses inspection") {
        channel.reply({
          v: 1,
          kind: "sps.native.signer.response",
          id: inspect.id,
          ok: false,
          errorCode: "native_signer_unavailable",
        });
      } else {
        channel.connected = false;
        channel.emit("disconnect");
      }

      await expect(creation).rejects.toMatchObject({ status: 403 });
      expect(identity.resolveNativeEnrollmentSessionFromHeaders).not.toHaveBeenCalled();
      expect(channel.messages).toHaveLength(1);
      expect(channel.listenerCount("message")).toBe(0);
      expect(channel.listenerCount("disconnect")).toBe(0);
    },
  );

  it("does not resolve a session for non-Host transport, non-session actors, or a missing Desktop proof", async () => {
    const identity = identityWith(async () => sessionFixture());
    const { management } = await createManagement(identity);
    const forwardedHost = "desktop.example.ts.net";
    const rejected: Array<[string, Request]> = [
      ["non-Host hostname", authenticatedHostRequest({ host: "workspace.example.test" })],
      ["remote peer", authenticatedHostRequest({ remoteAddress: "192.0.2.10" })],
      ["agent", authenticatedHostRequest({ actor: { type: "agent", source: "agent_key" } })],
      ["board key", authenticatedHostRequest({ actor: { type: "board", source: "board_key", userId: ACTOR_USER_ID } })],
      ["implicit actor", authenticatedHostRequest({ actor: { type: "board", source: "local_implicit", userId: ACTOR_USER_ID } })],
      ["one proof", authenticatedHostRequest({ proofHeaders: [["x-sps-desktop-access", DESKTOP_TOKEN]] })],
      ["forwarded Host", authenticatedHostRequest({
        host: forwardedHost,
        extraHeaders: {
          "x-forwarded-host": forwardedHost,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "198.51.100.10",
          "tailscale-user-login": "owner@example.test",
          "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
        },
      })],
    ];

    for (const [label, request] of rejected) {
      await expect(management.resolveHostSession(request), label).rejects.toMatchObject({ status: 403 });
    }
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("requires one bounded raw Cookie header and rejects Authorization", async () => {
    const identity = identityWith(async () => sessionFixture());
    const { management } = await createManagement(identity);
    const rejected: Array<[string, Request]> = [
      ["duplicate cookies", authenticatedHostRequest({ rawCookies: [SESSION_COOKIE, SESSION_COOKIE] })],
      ["missing raw cookie", authenticatedHostRequest({ rawCookies: [] })],
      ["overlong cookie", authenticatedHostRequest({ rawCookies: ["x".repeat(8193)] })],
      ["Authorization", authenticatedHostRequest({ extraHeaders: { Authorization: "Bearer agent-token" } })],
    ];

    for (const [label, request] of rejected) {
      await expect(management.resolveHostSession(request), label).rejects.toMatchObject({ status: 403 });
    }
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("rejects a resolved session whose user differs from the authenticated actor", async () => {
    const identity = identityWith(async () => sessionFixture(OTHER_USER_ID));
    const { management } = await createManagement(identity);

    await expect(management.resolveHostSession(authenticatedHostRequest())).rejects.toMatchObject({ status: 403 });
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledTimes(1);
  });

  it("rejects a locally authenticated session and actor that agree with each other but not the configured Owner", async () => {
    const session = sessionFixture(OTHER_USER_ID);
    const identity = identityWith(async () => session);
    const { management } = await createManagement(identity);
    const request = authenticatedHostRequest({
      actor: { type: "board", source: "session", userId: OTHER_USER_ID },
    });

    await expect(management.resolveHostSession(request)).rejects.toMatchObject({ status: 403 });
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(session.authorizeInTransaction).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid configured Owner identity before parent IPC", async () => {
    const identity = identityWith(async () => sessionFixture());
    const invalidOptions: Array<[string, unknown]> = [
      ["missing", undefined],
      ["empty", { ownerUserId: "" }],
      ["whitespace", { ownerUserId: "  " }],
      ["overlong", { ownerUserId: "u".repeat(201) }],
      ["control character", { ownerUserId: "owner\nuser" }],
    ];

    for (const [label, options] of invalidOptions) {
      const channel = new FakeIpcChannel();
      await expect(
        createSpsNativeHostManagement(identity, options as never, channel),
        label,
      ).rejects.toMatchObject({ status: 403 });
      expect(channel.messages, label).toHaveLength(0);
      expect(channel.listenerCount("message"), label).toBe(0);
      expect(channel.listenerCount("disconnect"), label).toBe(0);
    }
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("checks the expected user before invoking the session authorizer", async () => {
    const session = sessionFixture();
    const identity = identityWith(async () => session);
    const { management } = await createManagement(identity);
    const hostSession = await management.resolveHostSession(authenticatedHostRequest());

    await expect(hostSession.authorizeInTransaction({} as never, OTHER_USER_ID)).rejects.toMatchObject({ status: 403 });
    expect(session.authorizeInTransaction).not.toHaveBeenCalled();
  });

  it("rechecks an in-flight session resolution after parent disconnect", async () => {
    const entered = deferred<void>();
    const pendingSession = deferred<SpsIdentityNativeEnrollmentSession>();
    const identity = identityWith(async () => {
      entered.resolve();
      return await pendingSession.promise;
    });
    const channel = new FakeIpcChannel();
    const { management } = await createManagement(identity, channel);
    const resolving = management.resolveHostSession(authenticatedHostRequest());
    await entered.promise;

    channel.connected = false;
    channel.emit("disconnect");
    pendingSession.resolve(sessionFixture());

    await expect(resolving).rejects.toMatchObject({ status: 403 });
    await expect(management.resolveHostSession(authenticatedHostRequest())).rejects.toMatchObject({ status: 403 });
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledTimes(1);
  });

  it("fences new requests and authorization before and after disposal around an awaited guard", async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const authorize = vi.fn(async (_tx: unknown, _expectedUserId: string) => {
      entered.resolve();
      await gate.promise;
    });
    const session = sessionFixture(ACTOR_USER_ID, authorize);
    const identity = identityWith(async () => session);
    const { management } = await createManagement(identity);
    const hostSession = await management.resolveHostSession(authenticatedHostRequest());
    const inFlightAuthorization = hostSession.authorizeInTransaction({} as never, ACTOR_USER_ID);
    await entered.promise;

    management.dispose();
    gate.resolve();

    await expect(inFlightAuthorization).rejects.toMatchObject({ status: 403 });
    expect(() => management.assertActive()).toThrow();
    await expect(hostSession.authorizeInTransaction({} as never, ACTOR_USER_ID)).rejects.toMatchObject({ status: 403 });
    await expect(management.resolveHostSession(authenticatedHostRequest())).rejects.toMatchObject({ status: 403 });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(identity.resolveNativeEnrollmentSessionFromHeaders).toHaveBeenCalledTimes(1);
  });
});
