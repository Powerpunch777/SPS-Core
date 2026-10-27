import { randomUUID } from "node:crypto";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import type { Db } from "../compat/paperclip/db.js";
import { createSpsNativeWorkspaceHttpServer } from "./sps-native-workspace-http.js";
import { createSpsNativeWorkspaceProofVerifier } from "./sps-native-workspace-proof.js";
import { createSpsNativeWorkspaceSurfaceReader } from "./sps-native-workspace-surfaces.js";
import type { createSpsNativePluginRuntime } from "./sps-native-plugin-runtime.js";

const REQUEST = "sps.native.workspace.bootstrap.request";
const RESPONSE = "sps.native.workspace.bootstrap.response";
const READY = "sps.native.workspace.bootstrap.ready";
const CLOSE = "sps.native.workspace.bootstrap.close";
const FAILURE = "native_workspace_unavailable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_TIMEOUT_MS = 10_000;

type Channel = {
  connected?: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): unknown;
  on(event: "message" | "disconnect" | "exit", listener: (message?: unknown) => void): unknown;
  removeListener(event: "message" | "disconnect" | "exit", listener: (message?: unknown) => void): unknown;
};
type Runtime = Readonly<{ host: "127.0.0.1"; port: number; dispose(): Promise<void> | void }>;
type Options = Readonly<{
  hostId: string;
  serverSpkiSha256: string;
  issuerSpkiSha256: string;
  assertCurrent(): void;
  start(key: Buffer, assertCurrent: () => void): Promise<Runtime>;
}>;
type WorkspaceOptions = Readonly<{
  db: Db;
  identity: Pick<ReturnType<typeof createSpsIdentityAuth>, "resolveNativeEnrollmentSessionFromHeaders">;
  hostId: string;
  serverSpkiSha256: string;
  issuerSpkiSha256: string;
  assertCurrent(): void;
  getPluginRuntime?: () => ReturnType<typeof createSpsNativePluginRuntime> | undefined;
}>;

function fail(): never { throw new Error(FAILURE); }

function exactRecord(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.some(key => typeof key !== "string" || !keys.includes(key))
      || required.some(key => !Object.hasOwn(descriptors, key))) throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of actual as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error();
      result[key] = descriptor.value;
    }
    return result;
  } catch { return fail(); }
}

function checkCurrent(assertion: () => void, connected: () => boolean) {
  try {
    if (connected() !== true) fail();
    const result = assertion() as unknown;
    if (result !== undefined) {
      if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
      fail();
    }
    if (connected() !== true) fail();
  } catch { fail(); }
}

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || !KEY.test(value)) return fail();
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    key.fill(0);
    return fail();
  }
  return key;
}

/** One-time Main-to-Core key bootstrap for the dedicated private Workspace channel. */
export function createSpsNativeWorkspaceChannelBootstrap(optionsValue: Options, channelValue: unknown = process) {
  const options = exactRecord(optionsValue, ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "assertCurrent", "start"]);
  if (typeof options.hostId !== "string" || !UUID.test(options.hostId)
    || typeof options.serverSpkiSha256 !== "string" || !SHA256.test(options.serverSpkiSha256)
    || typeof options.issuerSpkiSha256 !== "string" || !SHA256.test(options.issuerSpkiSha256)
    || typeof options.assertCurrent !== "function" || typeof options.start !== "function") throw new TypeError("Invalid Native Workspace channel configuration.");
  const channel = channelValue as Channel;
  if (!channel || typeof channel.send !== "function" || typeof channel.on !== "function"
    || typeof channel.removeListener !== "function") throw new TypeError("Invalid Native Workspace IPC channel.");

  const id = randomUUID();
  let disposed = false;
  let completed = false;
  let readySettled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let launchKey: Buffer | undefined;
  let runtime: Runtime | undefined;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (value: Readonly<{ host: "127.0.0.1"; port: number }>) => void;
  const ready = new Promise<Readonly<{ host: "127.0.0.1"; port: number }>>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Attach a handler immediately: a parent disconnect may reject before the
  // caller has begun awaiting startup.
  void ready.catch(() => {});

  const isConnected = () => channel.connected === true;
  const assertAvailable = () => {
    try {
      if (disposed) fail();
      checkCurrent(options.assertCurrent as () => void, isConnected);
      if (disposed) fail();
    } catch {
      void dispose().catch(() => {});
      fail();
    }
  };
  const send = (message: unknown) => new Promise<void>((resolve, reject) => {
    try {
      if (channel.connected !== true) return reject(new Error(FAILURE));
      channel.send(message, error => error ? reject(new Error(FAILURE)) : resolve());
    } catch { reject(new Error(FAILURE)); }
  });
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const awaitStartup = async () => {
    if (!startup) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        startup,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error(FAILURE)), RESPONSE_TIMEOUT_MS);
        }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
  };

  const startFromResponse = (raw: unknown) => {
    const response = exactRecord(raw,
      ["v", "kind", "id", "ok", "hostId", "serverSpkiSha256", "issuerSpkiSha256", "key", "errorCode"],
      ["v", "kind", "id", "ok"]);
    if (response.v !== 1 || response.kind !== RESPONSE || response.id !== id || typeof response.ok !== "boolean") fail();
    if (response.ok === false) {
      if (Object.hasOwn(response, "key") || Object.hasOwn(response, "hostId")
        || Object.hasOwn(response, "serverSpkiSha256") || Object.hasOwn(response, "issuerSpkiSha256")
        || response.errorCode !== FAILURE) fail();
      fail();
    }
    if (Object.hasOwn(response, "errorCode") || response.hostId !== options.hostId
      || response.serverSpkiSha256 !== options.serverSpkiSha256
      || response.issuerSpkiSha256 !== options.issuerSpkiSha256 || typeof response.key !== "string") fail();
    const key = decodeKey(response.key);
    if (completed || disposed) { key.fill(0); fail(); }
    launchKey = key;
    completed = true;
    startup = Promise.resolve().then(async () => {
      try {
        assertAvailable();
        const started = await (options.start as Options["start"])(key, assertAvailable);
        if (disposed) {
          await started?.dispose();
          fail();
        }
        runtime = started;
        if (!started || started.host !== "127.0.0.1" || !Number.isInteger(started.port) || started.port < 1 || started.port > 65535
          || typeof started.dispose !== "function") fail();
        assertAvailable();
        await send({
          v: 1, kind: READY, id,
          hostId: options.hostId,
          serverSpkiSha256: options.serverSpkiSha256,
          issuerSpkiSha256: options.issuerSpkiSha256,
          host: "127.0.0.1",
          port: started.port,
        });
        assertAvailable();
        clearTimer();
        readySettled = true;
        resolveReady(Object.freeze({ host: "127.0.0.1", port: started.port }));
      } catch {
        key.fill(0);
        clearTimer();
        readySettled = true;
        void dispose().catch(() => {});
        rejectReady(new Error(FAILURE));
        return;
      } finally {
        key.fill(0);
        launchKey = undefined;
      }
    });
    void startup.catch(() => {
      clearTimer();
      readySettled = true;
      rejectReady(new Error(FAILURE));
      void dispose().catch(() => {});
    });
  };

  const onMessage = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const kind = Object.getOwnPropertyDescriptor(raw, "kind");
    if (!kind || !("value" in kind)) return;
    if (kind.value === CLOSE) {
      try {
        const close = exactRecord(raw, ["v", "kind", "id"]);
        if (close.v === 1 && close.kind === CLOSE && close.id === id) void dispose().catch(() => {});
      } catch { void dispose().catch(() => {}); }
      return;
    }
    if (kind.value !== RESPONSE) return;
    try { startFromResponse(raw); }
    catch {
      clearTimer();
      completed = true;
      readySettled = true;
      rejectReady(new Error(FAILURE));
      void dispose().catch(() => {});
    }
  };
  const onDisconnect = () => { void dispose().catch(() => {}); };
  const onExit = () => { void dispose().catch(() => {}); };
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  channel.on("exit", onExit);

  const dispose = () => {
    if (stopping) return stopping;
    disposed = true;
    clearTimer();
    launchKey?.fill(0);
    launchKey = undefined;
    channel.removeListener("message", onMessage);
    channel.removeListener("disconnect", onDisconnect);
    channel.removeListener("exit", onExit);
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(FAILURE));
    }
    stopping = (async () => {
      let startupError: unknown;
      try { await awaitStartup(); }
      catch (error) { startupError = error; }
      const ownedRuntime = runtime;
      runtime = undefined;
      let runtimeError: unknown;
      try { await ownedRuntime?.dispose(); }
      catch (error) { runtimeError = error; }
      if (startupError || runtimeError) throw new AggregateError(
        [startupError, runtimeError].filter(error => error !== undefined),
        FAILURE,
      );
    })();
    return stopping;
  };

  try {
    assertAvailable();
    timer = setTimeout(() => {
      if (readySettled || disposed) return;
      completed = true;
      readySettled = true;
      rejectReady(new Error(FAILURE));
      void dispose().catch(() => {});
    }, RESPONSE_TIMEOUT_MS);
    void send({
      v: 1,
      kind: REQUEST,
      id,
      hostId: options.hostId,
      serverSpkiSha256: options.serverSpkiSha256,
      issuerSpkiSha256: options.issuerSpkiSha256,
    }).catch(() => {
      if (disposed) return;
      completed = true;
      clearTimer();
      rejectReady(new Error(FAILURE));
      void dispose().catch(() => {});
    });
  } catch {
      void dispose().catch(() => {});
    rejectReady(new Error(FAILURE));
  }

  return Object.freeze({ ready, assertAvailable, dispose });
}

/** Starts the authenticated, private loopback Workspace surface after Main's
 * one-time child-key response. No ordinary Core listener or SDK route is used.
 */
export function createSpsNativeWorkspaceChannel(options: WorkspaceOptions, channelValue: unknown = process) {
  if (!options || !options.db || !options.identity
    || typeof options.identity.resolveNativeEnrollmentSessionFromHeaders !== "function") {
    throw new TypeError("Invalid Native Workspace channel dependencies.");
  }
  return createSpsNativeWorkspaceChannelBootstrap({
    hostId: options.hostId,
    serverSpkiSha256: options.serverSpkiSha256,
    issuerSpkiSha256: options.issuerSpkiSha256,
    assertCurrent: options.assertCurrent,
    async start(key, assertCurrent) {
      const verifier = createSpsNativeWorkspaceProofVerifier({ hostId: options.hostId, key, assertCurrent });
      const reader = createSpsNativeWorkspaceSurfaceReader({
        db: options.db,
        identity: options.identity,
        hostId: options.hostId,
        verifier,
        assertCurrent,
        getPluginRuntime: options.getPluginRuntime,
      });
      const server = createSpsNativeWorkspaceHttpServer({ reader, assertCurrent });
      try {
        const endpoint = await server.start();
        let stopping: Promise<void> | undefined;
        return Object.freeze({
          host: endpoint.host,
          port: endpoint.port,
          dispose() {
            if (!stopping) stopping = (async () => {
              try { await server.dispose(); }
              finally { verifier.dispose(); }
            })();
            return stopping;
          },
        });
      } catch {
        try { await server.dispose(); }
        finally { verifier.dispose(); }
        throw new Error(FAILURE);
      }
    },
  }, channelValue);
}
