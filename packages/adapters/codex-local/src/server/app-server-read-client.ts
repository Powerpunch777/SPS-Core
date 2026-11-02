import type { Readable, Writable } from "node:stream";

export type CodexAppServerReadMethod =
  | "thread/list"
  | "thread/read"
  | "thread/turns/list"
  | "thread/items/list";

const READ_METHODS = new Set<string>([
  "thread/list", "thread/read", "thread/turns/list", "thread/items/list",
]);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function bound(value: number | undefined, fallback: number, min: number, max: number) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new TypeError("Invalid Codex observer transport bound.");
  }
  return selected;
}

/**
 * Read-only JSONL transport for a caller-owned, isolated app-server process.
 * This does not start a model, authorize child tools, or establish tenant scope.
 */
export function createCodexAppServerReadClient(options: {
  input: Readable;
  output: Writable;
  timeoutMs?: number;
  maxFrameBytes?: number;
}) {
  const { input, output } = options;
  const timeoutMs = bound(options.timeoutMs, 10_000, 10, 60_000);
  const maxFrameBytes = bound(options.maxFrameBytes, 1024 * 1024, 256, 8 * 1024 * 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  let closed = false;
  let initialized = false;
  let handshake: Promise<unknown> | undefined;

  function stop(message = "Codex observer connection closed.") {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
    input.off("close", onEnd);
    output.off("error", onError);
    output.off("close", onEnd);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    pending.clear();
  }

  function write(value: unknown) {
    if (closed) throw new Error("Codex observer connection closed.");
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
      throw new Error("Codex observer outgoing frame exceeds its bound.");
    }
    output.write(line, error => { if (error) stop("Codex observer output failed."); });
  }

  function onError() { stop("Codex observer transport failed."); }
  function onEnd() { stop("Codex observer transport ended."); }

  function receive(bytes: Buffer) {
    let value: unknown;
    try { value = JSON.parse(decoder.decode(bytes)); }
    catch { throw new Error("Invalid Codex observer JSON frame."); }
    if (!record(value) || (own(value, "jsonrpc") && value.jsonrpc !== "2.0")) {
      throw new Error("Invalid Codex observer envelope.");
    }
    if (own(value, "method")) {
      if (typeof value.method !== "string" || !value.method || value.method.length > 256
        || own(value, "result") || own(value, "error")) {
        throw new Error("Invalid Codex observer server request.");
      }
      if (own(value, "id")) {
        const id = value.id;
        if (!(Number.isSafeInteger(id) || typeof id === "string" && id.length > 0 && id.length <= 256)) {
          throw new Error("Invalid Codex observer server request identity.");
        }
        // No approvals, dynamic tools, token refresh, or shell requests are served here.
        write({ id, error: { code: -32601, message: "This connection supports observation only." } });
      }
      return;
    }
    if (!Number.isSafeInteger(value.id) || typeof value.id !== "number"
      || own(value, "result") === own(value, "error")
      || Object.keys(value).some(key => !["id", "result", "error", "jsonrpc"].includes(key))) {
      throw new Error("Invalid Codex observer response.");
    }
    const waiter = pending.get(value.id);
    if (!waiter) throw new Error("Unexpected Codex observer response identity.");
    if (own(value, "error") && (!record(value.error) || !Number.isSafeInteger(value.error.code)
      || typeof value.error.message !== "string")) {
      throw new Error("Invalid Codex observer error response.");
    }
    pending.delete(value.id);
    clearTimeout(waiter.timer);
    if (own(value, "error")) waiter.reject(new Error("Codex observer request was rejected."));
    else waiter.resolve(value.result);
  }

  function onData(chunk: Buffer | string) {
    if (closed) return;
    try {
      // A pre-decoded stream may already have replaced invalid UTF-8 bytes.
      if (!Buffer.isBuffer(chunk)) throw new Error("Codex observer requires byte frames.");
      const incoming = chunk;
      // Split before concatenating so a chunk containing many bounded frames is valid.
      let offset = 0;
      while (offset < incoming.length && !closed) {
        const newline = incoming.indexOf(10, offset);
        const end = newline === -1 ? incoming.length : newline;
        const segment = incoming.subarray(offset, end);
        if (buffer.length + segment.length > maxFrameBytes) throw new Error("Codex observer frame exceeds its bound.");
        buffer = Buffer.concat([buffer, segment]);
        if (newline === -1) break;
        const line = buffer;
        buffer = Buffer.alloc(0);
        receive(line);
        offset = end + 1;
      }
    } catch { stop("Codex observer protocol failed."); }
  }

  function send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (closed) return Promise.reject(new Error("Codex observer connection closed."));
    if (!record(params)) return Promise.reject(new TypeError("Codex observer parameters must be an object."));
    if (pending.size >= 16) return Promise.reject(new Error("Codex observer request limit reached."));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop("Codex observer request timed out; no retry was sent."), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params }); }
      catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Codex observer request could not be sent."));
        stop();
      }
    });
  }

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onError);
  input.on("close", onEnd);
  output.on("error", onError);
  output.on("close", onEnd);
  if (input.destroyed || input.readableEnded || output.destroyed || output.writableEnded) stop();

  return {
    initialize(): Promise<unknown> {
      if (!handshake) {
        handshake = send("initialize", {
          clientInfo: { name: "sps_native_observer", title: "SPS native session observer", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }).then(result => {
          if (!record(result)) throw new Error("Invalid Codex observer initialization.");
          write({ method: "initialized", params: {} });
          if (closed) throw new Error("Codex observer initialization ended.");
          initialized = true;
          return result;
        }).catch(error => { stop(); throw error; });
      }
      return handshake;
    },
    request(method: CodexAppServerReadMethod, params: Record<string, unknown>): Promise<unknown> {
      if (!initialized || !READ_METHODS.has(method)) {
        return Promise.reject(new Error("Codex observer only permits initialized read requests."));
      }
      return send(method, params);
    },
    close() { stop(); },
  };
}
