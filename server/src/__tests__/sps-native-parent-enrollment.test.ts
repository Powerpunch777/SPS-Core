import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { constructService } = vi.hoisted(() => ({ constructService: vi.fn() }));
vi.mock("../services/sps-native-enrollments.js", () => ({
  spsNativeEnrollmentService: (...args: unknown[]) => constructService(...args),
}));

import { createSpsNativeParentEnrollmentService } from "../services/sps-native-parent-enrollment.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_KEY_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_PIN = "a".repeat(64);
const ISSUER_PIN = "b".repeat(64);
const CERTIFICATE = Buffer.from([0x30, 0x00]).toString("base64url");
const REQUEST_PEM = `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from("request").toString("base64")}\n-----END CERTIFICATE REQUEST-----\n`;

class FakeIpcChannel extends EventEmitter {
  connected = true;
  messages: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    return true;
  }

  reply(message: unknown): void {
    this.emit("message", message);
  }
}

const active: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const value of active.splice(0)) value.dispose();
  constructService.mockReset();
});

const OPTIONS = {
  pairingPolicy: { maxTtlMs: 60_000, maxAttempts: 2, maxActiveInvites: 4 },
  certificateLifetimeMs: 60_000,
  signingTimeoutMs: 1000,
  maxConcurrentSignings: 2,
};

describe("SPS Native parent enrollment composition", () => {
  it("pins Core enrollment to one explicit parent inspect result and maps signing requests", async () => {
    const channel = new FakeIpcChannel();
    const serviceStub = { issue: vi.fn(), completeFromTlsPeer: vi.fn() };
    constructService.mockReturnValue(serviceStub);
    const creation = createSpsNativeParentEnrollmentService({} as never, OPTIONS, channel);
    const inspectRequest = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: inspectRequest.id,
      ok: true,
      result: {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        issuerCertificate: CERTIFICATE,
      },
    });
    const composition = await creation;
    active.push(composition);

    expect(constructService).toHaveBeenCalledTimes(1);
    const [passedDb, passedOptions, sign, assertActive] = constructService.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      (input: Record<string, unknown>) => Promise<unknown>,
      () => void,
    ];
    expect(passedDb).toEqual({});
    expect(passedOptions).toEqual({
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerCertificate: CERTIFICATE,
      pairingPolicy: OPTIONS.pairingPolicy,
      certificateLifetimeMs: OPTIONS.certificateLifetimeMs,
      signingTimeoutMs: OPTIONS.signingTimeoutMs,
      maxConcurrentSignings: OPTIONS.maxConcurrentSignings,
    });
    expect(channel.messages).toHaveLength(1);
    expect(assertActive).toBeTypeOf("function");

    const signPromise = sign({
      deviceKeyId: DEVICE_KEY_ID,
      requestPem: REQUEST_PEM,
      notBefore: 1_800_000_000_000,
      notAfter: 1_800_000_060_000,
      signal: new AbortController().signal,
    });
    const signRequest = channel.messages[1] as Record<string, unknown>;
    expect(signRequest).toMatchObject({
      v: 1,
      kind: "sps.native.signer.request",
      operation: "sign",
      payload: {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        deviceKeyId: DEVICE_KEY_ID,
        requestPem: REQUEST_PEM,
        notBefore: 1_800_000_000_000,
        notAfter: 1_800_000_060_000,
      },
    });
    const requestSha256 = createHash("sha256").update(REQUEST_PEM).digest("hex");
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: signRequest.id,
      ok: true,
      result: { certificate: CERTIFICATE, requestSha256 },
    });
    await expect(signPromise).resolves.toEqual({ certificate: CERTIFICATE, requestSha256 });
  });

  it("disposes the client and fails closed when initial inspection fails", async () => {
    const channel = new FakeIpcChannel();
    const creation = createSpsNativeParentEnrollmentService({} as never, OPTIONS, channel);
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: request.id,
      ok: false,
      errorCode: "native_signer_unavailable",
    });

    await expect(creation).rejects.toMatchObject({ code: "native_signer_unavailable" });
    expect(channel.listenerCount("message")).toBe(0);
    expect(channel.listenerCount("disconnect")).toBe(0);
    expect(constructService).not.toHaveBeenCalled();
  });

  it("fences returned service methods after disposal before delegating", async () => {
    const channel = new FakeIpcChannel();
    const serviceStub = { issue: vi.fn(), completeFromTlsPeer: vi.fn() };
    constructService.mockReturnValue(serviceStub);
    const creation = createSpsNativeParentEnrollmentService({} as never, OPTIONS, channel);
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: request.id,
      ok: true,
      result: {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        issuerCertificate: CERTIFICATE,
      },
    });
    const composition = await creation;
    composition.dispose();

    await expect(composition.service.issue({} as never)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(composition.service.completeFromTlsPeer({} as never, {} as never))
      .rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect(serviceStub.issue).not.toHaveBeenCalled();
    expect(serviceStub.completeFromTlsPeer).not.toHaveBeenCalled();
  });

  it("fences issue replay and completion before delegation after IPC disconnect", async () => {
    const channel = new FakeIpcChannel();
    const serviceStub = { issue: vi.fn(), completeFromTlsPeer: vi.fn() };
    constructService.mockReturnValue(serviceStub);
    const creation = createSpsNativeParentEnrollmentService({} as never, OPTIONS, channel);
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: request.id,
      ok: true,
      result: {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        issuerCertificate: CERTIFICATE,
      },
    });
    const composition = await creation;
    active.push(composition);
    channel.connected = false;
    channel.emit("disconnect");

    await expect(composition.service.issue({} as never)).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    await expect(composition.service.completeFromTlsPeer({} as never, {} as never))
      .rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect(serviceStub.issue).not.toHaveBeenCalled();
    expect(serviceStub.completeFromTlsPeer).not.toHaveBeenCalled();
  });

  it("rolls back completion when disconnect makes the parent's post-write guard fail", async () => {
    const channel = new FakeIpcChannel();
    let unblock!: () => void;
    let entered!: () => void;
    const writeGate = new Promise<void>(resolve => { unblock = resolve; });
    const completionEntered = new Promise<void>(resolve => { entered = resolve; });
    let eventWritten = false;
    let committed = false;
    let assertParentActive!: () => void;
    const delegate = {
      issue: vi.fn(),
      completeFromTlsPeer: vi.fn(async () => {
        eventWritten = true;
        entered();
        await writeGate;
        try {
          assertParentActive();
          committed = true;
        } catch (error) {
          eventWritten = false;
          throw error;
        }
      }),
    };
    constructService.mockImplementation((_db, _options, _sign, guard) => {
      assertParentActive = guard as () => void;
      return delegate;
    });
    const creation = createSpsNativeParentEnrollmentService({} as never, OPTIONS, channel);
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      v: 1,
      kind: "sps.native.signer.response",
      id: request.id,
      ok: true,
      result: {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        issuerCertificate: CERTIFICATE,
      },
    });
    const composition = await creation;
    active.push(composition);

    const completion = composition.service.completeFromTlsPeer({} as never, {} as never);
    await completionEntered;
    channel.connected = false;
    channel.emit("disconnect");
    unblock();

    await expect(completion).rejects.toMatchObject({ code: "native_enrollment_unavailable" });
    expect(eventWritten).toBe(false);
    expect(committed).toBe(false);
    expect(delegate.completeFromTlsPeer).toHaveBeenCalledTimes(1);
  });
});
