import { EventEmitter } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsNativeWorkspaceChannelBootstrap } from "../services/sps-native-workspace-channel.js";
import { createSpsNativeWorkspaceHttpServer } from "../services/sps-native-workspace-http.js";

const HOST = "f0bd6464-e665-4d46-a1a6-d71e0cbe1070";
const SERVER_PIN = "1".repeat(64);
const ISSUER_PIN = "2".repeat(64);
const KEY = Buffer.alloc(32, 0x37);
const FAILURE = "native_workspace_unavailable";

class FakeChannel extends EventEmitter {
  connected = true;
  messages: Record<string, unknown>[] = [];
  holdReady = false;
  failReady = false;
  heldReadyCallback: ((error: Error | null) => void) | undefined;

  send(message: unknown, callback?: (error: Error | null) => void) {
    this.messages.push(message as Record<string, unknown>);
    const isReady = (message as { kind?: unknown })?.kind === "sps.native.workspace.bootstrap.ready";
    if (callback && isReady && this.holdReady) this.heldReadyCallback = callback;
    else if (callback) {
      queueMicrotask(() => callback(isReady && this.failReady ? new Error("private IPC send failed") : null));
    }
    return true;
  }

  response(overrides: Record<string, unknown> = {}) {
    const request = this.messages[0]!;
    this.emit("message", {
      v: 1,
      kind: "sps.native.workspace.bootstrap.response",
      id: request.id,
      ok: true,
      hostId: HOST,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      key: KEY.toString("base64url"),
      ...overrides,
    });
  }

  releaseReady() {
    const callback = this.heldReadyCallback;
    this.heldReadyCallback = undefined;
    callback?.(null);
  }
}

function options(start: (key: Buffer, assertCurrent: () => void) => Promise<{
  host: "127.0.0.1"; port: number; dispose(): Promise<void> | void;
}>, assertCurrent: () => void = () => {}) {
  return { hostId: HOST, serverSpkiSha256: SERVER_PIN, issuerSpkiSha256: ISSUER_PIN, assertCurrent, start };
}

afterEach(() => { vi.useRealTimers(); });

describe("SPS Native Workspace child bootstrap", () => {
  it("requests a one-time key, binds the returned pins, and announces only the live loopback endpoint", async () => {
    const channel = new FakeChannel();
    let receivedKey: Buffer | undefined;
    let keyAtStart: Buffer | undefined;
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async key => {
      receivedKey = key;
      keyAtStart = Buffer.from(key);
      return { host: "127.0.0.1", port: 43821, async dispose() { disposed++; } };
    }), channel);

    expect(channel.messages[0]).toMatchObject({
      v: 1,
      kind: "sps.native.workspace.bootstrap.request",
      hostId: HOST,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
    });
    expect(Object.keys(channel.messages[0]!).sort()).toEqual([
      "hostId", "id", "issuerSpkiSha256", "kind", "serverSpkiSha256", "v",
    ]);
    channel.response();

    await expect(service.ready).resolves.toEqual({ host: "127.0.0.1", port: 43821 });
    expect(keyAtStart).toEqual(Buffer.alloc(32, 0x37));
    expect(receivedKey).toEqual(Buffer.alloc(32));
    expect(channel.messages[1]).toEqual({
      v: 1,
      kind: "sps.native.workspace.bootstrap.ready",
      id: channel.messages[0]!.id,
      hostId: HOST,
      serverSpkiSha256: SERVER_PIN,
      issuerSpkiSha256: ISSUER_PIN,
      host: "127.0.0.1",
      port: 43821,
    });
    await service.dispose();
    expect(disposed).toBe(1);
  });

  it("rejects unknown response fields and a pin mismatch without starting the listener", async () => {
    for (const overrides of [{ extra: true }, { issuerSpkiSha256: "3".repeat(64) }]) {
      const channel = new FakeChannel();
      let started = false;
      const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => {
        started = true;
        return { host: "127.0.0.1", port: 1234, dispose() {} };
      }), channel);
      channel.response(overrides);
      await expect(service.ready).rejects.toThrow(FAILURE);
      await service.dispose();
      expect(started).toBe(false);
    }
  });

  it("accepts only Main's fixed unavailable response and treats it as workspace-only failure", async () => {
    const channel = new FakeChannel();
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => {
      throw new Error("must not start");
    }), channel);
    channel.emit("message", {
      v: 1,
      kind: "sps.native.workspace.bootstrap.response",
      id: channel.messages[0]!.id,
      ok: false,
      errorCode: FAILURE,
    });
    await expect(service.ready).rejects.toThrow(FAILURE);
    await service.dispose();
    expect(channel.listenerCount("message")).toBe(0);
  });

  it("requires a connected direct IPC channel and disposes on parent loss or current-generation loss", async () => {
    const disconnected = new FakeChannel();
    disconnected.connected = false;
    const inactive = createSpsNativeWorkspaceChannelBootstrap(options(async () => {
      throw new Error("must not start");
    }), disconnected);
    await expect(inactive.ready).rejects.toThrow(FAILURE);
    expect(disconnected.messages).toHaveLength(0);

    const channel = new FakeChannel();
    let valid = true;
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => ({
      host: "127.0.0.1", port: 32345, dispose() { disposed++; },
    }), () => { if (!valid) throw new Error("Host generation changed"); }), channel);
    channel.response();
    await service.ready;
    valid = false;
    expect(() => service.assertAvailable()).toThrow(FAILURE);
    await service.dispose();
    expect(disposed).toBe(1);
  });

  it("times out a stalled ready delivery and closes the already bound listener", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    channel.holdReady = true;
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => ({
      host: "127.0.0.1", port: 32346, dispose() { disposed++; },
    })), channel);
    channel.response();
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(service.ready).rejects.toThrow(FAILURE);
    channel.releaseReady();
    await service.dispose();
    expect(disposed).toBe(1);
  });

  it("still closes a bound listener when ready-send never settles, and reports the unjoined startup", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    channel.holdReady = true;
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => ({
      host: "127.0.0.1", port: 32349, dispose() { disposed++; },
    })), channel);
    channel.response();
    await vi.advanceTimersByTimeAsync(1);
    const stoppingFailure = expect(service.dispose()).rejects.toThrow(FAILURE);
    await vi.advanceTimersByTimeAsync(10_001);
    await stoppingFailure;
    expect(disposed).toBe(1);
    await expect(service.ready).rejects.toThrow(FAILURE);
  });

  it("does not finish disposal until an in-progress startup returns and its late listener is closed", async () => {
    const channel = new FakeChannel();
    let release!: () => void;
    let entered!: () => void;
    const enteredStart = new Promise<void>(resolve => { entered = resolve; });
    const waitForStart = new Promise<void>(resolve => { release = resolve; });
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => {
      entered();
      await waitForStart;
      return { host: "127.0.0.1", port: 32348, dispose() { disposed++; } };
    }), channel);
    channel.response();
    await enteredStart;
    const stopping = service.dispose();
    let finished = false;
    void stopping.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await stopping;
    await expect(service.ready).rejects.toThrow(FAILURE);
    expect(disposed).toBe(1);
  });

  it("announces only a started private HTTP adapter and serves through its exact loopback port", async () => {
    const channel = new FakeChannel();
    let capturedPath = "";
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async (_key, assertCurrent) => {
      const http = createSpsNativeWorkspaceHttpServer({
        reader: { async read(_proof, actual) { capturedPath = actual.target; return { surface: "dashboard" }; } },
        assertCurrent,
      });
      const endpoint = await http.start();
      return { ...endpoint, dispose: () => http.dispose() };
    }), channel);
    channel.response();
    const endpoint = await service.ready;
    const path = `/api/companies/${HOST}/workspace-dashboard`;
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const requestValue = request({
        host: endpoint.host,
        port: endpoint.port,
        method: "GET",
        path,
        headers: {
          "x-sps-native-workspace-proof": "test-proof",
          cookie: "sps_identity_session=" + "a".repeat(64),
        },
      }, value => {
        let body = "";
        value.setEncoding("utf8");
        value.on("data", chunk => { body += chunk; });
        value.on("end", () => resolve({ status: value.statusCode ?? 0, body }));
      });
      requestValue.on("error", reject);
      requestValue.end();
    });
    expect(response).toEqual({ status: 200, body: JSON.stringify({ surface: "dashboard" }) });
    expect(capturedPath).toBe(path);
    await service.dispose();
  });

  it("closes the workspace listener on Main's matching close message", async () => {
    const channel = new FakeChannel();
    let disposed = 0;
    const service = createSpsNativeWorkspaceChannelBootstrap(options(async () => ({
      host: "127.0.0.1", port: 32347, dispose() { disposed++; },
    })), channel);
    channel.response();
    await service.ready;
    channel.emit("message", {
      v: 1, kind: "sps.native.workspace.bootstrap.close", id: channel.messages[0]!.id,
    });
    await service.dispose();
    expect(disposed).toBe(1);
  });
});
