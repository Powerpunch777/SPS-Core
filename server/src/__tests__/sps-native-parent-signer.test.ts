import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createSpsNativeParentSignerClient } from "../services/sps-native-parent-signer.js";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const DEVICE_KEY_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_PIN = "a".repeat(64);
const ISSUER_PIN = "b".repeat(64);
const CERTIFICATE = Buffer.from([0x30, 0x00]).toString("base64url");
const REQUEST_PEM = `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from("request").toString("base64")}\n-----END CERTIFICATE REQUEST-----\n`;

class FakeIpcChannel extends EventEmitter {
  connected = true;
  sendResult = true;
  messages: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    return this.sendResult;
  }

  reply(message: unknown): void {
    this.emit("message", message);
  }

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }

  exit(): void {
    this.emit("exit", 0);
  }
}

const clients: Array<ReturnType<typeof createSpsNativeParentSignerClient>> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function client(channel = new FakeIpcChannel(), options: { timeoutMs?: number; maxPending?: number } = {}) {
  const value = createSpsNativeParentSignerClient(channel, options);
  clients.push(value);
  return { value, channel };
}

function response(id: string, result: unknown) {
  return { v: 1, kind: "sps.native.signer.response", id, ok: true, result };
}

describe("SPS Native parent signer IPC client", () => {
  it("does not auto-inspect and sends the explicit inspect protocol", async () => {
    const { value, channel } = client();
    expect(channel.messages).toEqual([]);

    const resultPromise = value.inspect();
    const request = channel.messages[0] as Record<string, unknown>;
    expect(request).toMatchObject({ v: 1, kind: "sps.native.signer.request", operation: "inspect" });
    expect(request.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Object.keys(request).sort()).toEqual(["id", "kind", "operation", "v"]);
    channel.reply(response(request.id as string, {
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      issuerCertificate: CERTIFICATE,
    }));

    await expect(resultPromise).resolves.toEqual({
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      issuerCertificate: CERTIFICATE,
    });
  });

  it("sends only the validated sign payload and binds the result hash to its CSR", async () => {
    const { value, channel } = client();
    const payload = {
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      deviceKeyId: DEVICE_KEY_ID,
      requestPem: REQUEST_PEM,
      notBefore: 1_800_000_000_000,
      notAfter: 1_800_000_060_000,
    };
    const resultPromise = value.sign(payload);
    const request = channel.messages[0] as Record<string, unknown>;
    expect(request).toMatchObject({ v: 1, kind: "sps.native.signer.request", operation: "sign", payload });
    expect(Object.keys(request).sort()).toEqual(["id", "kind", "operation", "payload", "v"]);
    const requestSha256 = createHash("sha256").update(REQUEST_PEM).digest("hex");
    channel.reply(response(request.id as string, { certificate: CERTIFICATE, requestSha256 }));

    await expect(resultPromise).resolves.toEqual({ certificate: CERTIFICATE, requestSha256 });
  });

  it("accepts send(false) backpressure and waits for the matching response", async () => {
    const { value, channel } = client();
    channel.sendResult = false;
    const resultPromise = value.inspect();
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply(response(request.id as string, {
      hostId: HOST_ID,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      issuerCertificate: CERTIFICATE,
    }));

    await expect(resultPromise).resolves.toMatchObject({ hostId: HOST_ID });
    expect(channel.messages).toHaveLength(1);
  });

  it("rejects accessors, unknown keys, malformed PEM, and overlong signing validity before sending", async () => {
    const { value, channel } = client();
    const accessorInput = { ...validSignInput(), extra: true } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "requestPem", { enumerable: true, get: () => { throw new Error("must not read"); } });

    await expect(value.sign(accessorInput as never)).rejects.toThrow("Invalid SPS Native signer request.");
    await expect(value.sign({ ...validSignInput(), requestPem: "not a CSR" })).rejects.toThrow("Invalid SPS Native signer request.");
    await expect(value.sign({ ...validSignInput(), notAfter: 1_800_000_000_000 + 90 * 24 * 60 * 60 * 1000 + 1 })).rejects.toThrow("Invalid SPS Native signer request.");
    expect(channel.messages).toEqual([]);
  });

  it("rejects malformed or non-canonical responses without exposing their data", async () => {
    const { value, channel } = client();
    const resultPromise = value.inspect();
    const request = channel.messages[0] as Record<string, unknown>;
    channel.reply({
      ...response(request.id as string, {
        hostId: HOST_ID,
        serverSpkiSha256: SERVER_PIN,
        issuerSpkiSha256: ISSUER_PIN,
        issuerCertificate: `${CERTIFICATE}=`,
      }),
      unexpected: "private-value",
    });

    await expect(resultPromise).rejects.toMatchObject({ code: "native_signer_unavailable" });
    await expect(resultPromise).rejects.not.toThrow(/private-value|issuerCertificate/);
    expect(channel.messages.at(-1)).toEqual({
      v: 1,
      kind: "sps.native.signer.request",
      id: request.id,
      operation: "cancel",
    });
  });

  it("bounds pending calls and sends best-effort cancellation on abort and timeout", async () => {
    const { value, channel } = client(new FakeIpcChannel(), { timeoutMs: 15, maxPending: 1 });
    const controller = new AbortController();
    const aborted = value.inspect({ signal: controller.signal });
    await expect(value.inspect()).rejects.toMatchObject({ code: "native_signer_busy" });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "native_signer_aborted" });

    const timedOut = value.inspect();
    await expect(timedOut).rejects.toMatchObject({ code: "native_signer_timeout" });
    expect(channel.messages.filter(message => (message as { operation?: string }).operation === "cancel")).toHaveLength(2);
  });

  it("rejects pending calls and removes listeners after disconnect or disposal", async () => {
    const disconnected = client();
    expect(disconnected.value.isAvailable()).toBe(true);
    const pendingOnDisconnect = disconnected.value.inspect();
    disconnected.channel.disconnect();
    expect(disconnected.value.isAvailable()).toBe(false);
    expect(() => disconnected.value.assertAvailable()).toThrow(/SPS Native signer is unavailable/);
    await expect(pendingOnDisconnect).rejects.toMatchObject({ code: "native_signer_unavailable" });
    await expect(disconnected.value.inspect()).rejects.toMatchObject({ code: "native_signer_unavailable" });

    const exited = client();
    const pendingOnExit = exited.value.inspect();
    exited.channel.exit();
    expect(exited.value.isAvailable()).toBe(false);
    expect(() => exited.value.assertAvailable()).toThrow(/SPS Native signer is unavailable/);
    await expect(pendingOnExit).rejects.toMatchObject({ code: "native_signer_unavailable" });

    const disposed = client();
    const pendingOnDispose = disposed.value.inspect();
    disposed.value.dispose();
    expect(disposed.value.isAvailable()).toBe(false);
    await expect(pendingOnDispose).rejects.toMatchObject({ code: "native_signer_unavailable" });
    expect(disposed.channel.listenerCount("message")).toBe(0);
    expect(disposed.channel.listenerCount("disconnect")).toBe(0);
    expect(disposed.channel.listenerCount("exit")).toBe(0);
  });

  it("rejects unsupported IPC channels and invalid response accessors", async () => {
    expect(() => createSpsNativeParentSignerClient({})).toThrow(/SPS Native signer is unavailable/);
    const { value, channel } = client();
    const resultPromise = value.inspect();
    const request = channel.messages[0] as Record<string, unknown>;
    const malformed = { v: 1, kind: "sps.native.signer.response", id: request.id, ok: true };
    Object.defineProperty(malformed, "result", { enumerable: true, get: () => { throw new Error("private-data"); } });
    channel.reply(malformed);
    await expect(resultPromise).rejects.toMatchObject({ code: "native_signer_unavailable" });
  });

  it("rejects duck-typed signal objects without evaluating their getters", async () => {
    const { value, channel } = client();
    let getterCalls = 0;
    const fakeSignal = Object.defineProperties({}, {
      aborted: { get: () => { getterCalls++; throw new Error("must not run"); } },
      addEventListener: { get: () => { getterCalls++; throw new Error("must not run"); } },
      removeEventListener: { get: () => { getterCalls++; throw new Error("must not run"); } },
    });

    await expect(value.inspect({ signal: fakeSignal as AbortSignal })).rejects.toThrow("Invalid SPS Native signer request.");
    expect(getterCalls).toBe(0);
    expect(channel.messages).toEqual([]);
  });
});

function validSignInput() {
  return {
    hostId: HOST_ID,
    serverSpkiSha256: SERVER_PIN,
    issuerSpkiSha256: ISSUER_PIN,
    deviceKeyId: DEVICE_KEY_ID,
    requestPem: REQUEST_PEM,
    notBefore: 1_800_000_000_000,
    notAfter: 1_800_000_060_000,
  };
}
