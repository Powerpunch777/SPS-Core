import { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "exchangeSession">;
type Options = { readTimeoutMs: number; operationTimeoutMs: number; maxConcurrentRequests: number };
type Pending = { cancelled: boolean; controller: AbortController; request: IncomingMessage; response: ServerResponse;
  socket: TLSSocket; operation?: Promise<unknown> };
const PATH = "/sps-native/v1/session/exchange";
const CODE = "native_session_exchange_unavailable";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_TOKEN = /^[A-Za-z0-9_-]{64}$/;
const JWT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

class RequestFailure extends Error {
  constructor(readonly status: number) { super(CODE); }
}
function fail(status: number): never { throw new RequestFailure(status); }

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length) throw new TypeError();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = fields[key];
    if (!field?.enumerable || !("value" in field)) throw new TypeError();
    result[key] = field.value;
  }
  return result;
}

function limits(input: Options): Options {
  let value: Record<string, unknown>;
  try { value = ownData(input, ["readTimeoutMs", "operationTimeoutMs", "maxConcurrentRequests"]); }
  catch { throw new TypeError("Invalid Native session exchange HTTP limits."); }
  for (const [key, min, max] of [["readTimeoutMs", 100, 10_000], ["operationTimeoutMs", 500, 60_000],
    ["maxConcurrentRequests", 1, 8]] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) {
      throw new TypeError("Invalid Native session exchange HTTP limits.");
    }
  }
  return Object.freeze(value as Options);
}

function tlsSocket(request: IncomingMessage): TLSSocket {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.destroyed || !socket.encrypted
    || socket.getProtocol() !== "TLSv1.3" || socket.isSessionReused()) fail(403);
  return socket;
}

function requestToken(request: IncomingMessage): string {
  if (request.rawHeaders.length % 2 !== 0 || request.rawHeaders.length / 2 > 64
    || request.rawHeaders.reduce((sum, field) => sum + Buffer.byteLength(field), 0) > 16_384) fail(400);
  const authorization: string[] = [], lengths: string[] = [], contentTypes: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase(), value = request.rawHeaders[index + 1]!;
    if (name === "authorization") authorization.push(value);
    if (name === "content-length") lengths.push(value);
    if (name === "content-type") contentTypes.push(value);
    if (name === "origin" || name === "referer" || name === "cookie" || name.startsWith("sec-fetch-")
      || name === "proxy-authorization" || name === "proxy-authenticate"
      || name === "transfer-encoding" || name === "content-encoding") fail(403);
  }
  if (lengths.length !== 1 || lengths[0] !== "0") fail(400);
  if (contentTypes.length > 1 || (contentTypes.length === 1
    && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentTypes[0]!))) fail(400);
  if (authorization.length !== 1) fail(401);
  const match = authorization[0]!.match(/^Bearer ([A-Za-z0-9_.-]+)$/i);
  const token = match?.[1] ?? "";
  if (!token || token.length >= 8192 || !JWT.test(token)) fail(401);
  return token;
}

function readEmpty(request: IncomingMessage, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: RequestFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.removeListener("data", onData); request.removeListener("end", onEnd);
      request.removeListener("error", onError); request.removeListener("aborted", onError);
      request.removeListener("close", onClose); signal.removeEventListener("abort", onAbort);
      if (error) { request.pause(); reject(error); } else resolve();
    };
    const onData = () => finish(new RequestFailure(400));
    const onEnd = () => finish(request.complete ? undefined : new RequestFailure(400));
    const onError = () => finish(new RequestFailure(400));
    const onClose = () => request.complete ? onEnd() : onError();
    const onAbort = () => finish(new RequestFailure(503));
    const timer = setTimeout(() => finish(new RequestFailure(408)), timeoutMs);
    request.on("data", onData); request.once("end", onEnd);
    request.on("error", onError); request.once("aborted", onError); request.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function result(value: unknown): { token: string; expiresInSeconds: number } {
  try {
    const fields = ownData(value, ["profile", "token", "expiresInSeconds"]);
    if (typeof fields.token !== "string" || !COOKIE_TOKEN.test(fields.token)
      || fields.expiresInSeconds !== SESSION_TTL_SECONDS) fail(503);
    return { token: fields.token, expiresInSeconds: fields.expiresInSeconds };
  } catch { fail(503); }
}

function send(response: ServerResponse, status: number, body: unknown, cookie?: string) {
  if (response.destroyed || response.writableEnded) return;
  try {
    const bytes = Buffer.from(JSON.stringify(body));
    response.shouldKeepAlive = false;
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length,
      "Cache-Control": "no-store", Connection: "close", "X-Content-Type-Options": "nosniff",
    };
    if (cookie) headers["Set-Cookie"] = `sps_identity_session=${cookie}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    response.writeHead(status, headers);
    response.end(bytes);
  } catch { response.destroy(); }
}

function status(error: unknown): number { return error instanceof RequestFailure ? error.status : 503; }

/** Inactive Native session exchange handler. It opens no socket and is not a Core route. */
export function createSpsNativeSessionExchangeRequestHandler(identity: Identity, inputLimits: Options) {
  const configuredLimits = limits(inputLimits);
  if (!identity || typeof identity.exchangeSession !== "function") throw new TypeError("Invalid SPS Identity session exchange.");
  let disposed = false;
  const active = new Map<Pending, true>();
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (request instanceof IncomingMessage) request.on("error", () => {});
    if (response instanceof ServerResponse) response.on("error", () => { if (!response.destroyed) response.destroy(); });
    let token: string, socket: TLSSocket;
    try {
      if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) fail(403);
      if (disposed) fail(503);
      if (request.url !== PATH) fail(404);
      if (request.method !== "POST") fail(403);
      socket = tlsSocket(request);
      token = requestToken(request);
      if (active.size >= configuredLimits.maxConcurrentRequests) fail(429);
    } catch (error) { send(response, status(error), { code: CODE }); return; }

    const state: Pending = { cancelled: false, controller: new AbortController(), request, response, socket };
    active.set(state, true);
    const assertActive = () => {
      if (disposed || state.cancelled || request.aborted || request.socket !== socket || socket.destroyed
        || response.destroyed || response.writableEnded) fail(503);
      if (tlsSocket(request) !== socket) fail(503);
    };
    const cancel = () => { state.cancelled = true; state.controller.abort(); };
    const onResponseClose = () => { if (!response.writableFinished) cancel(); };
    const onSocketClose = () => cancel();
    response.once("close", onResponseClose); socket.once("close", onSocketClose);
    const release = () => {
      active.delete(state); response.removeListener("close", onResponseClose); socket.removeListener("close", onSocketClose);
    };
    const metadata = Object.freeze({ ipAddress: socket.remoteAddress ?? null, userAgent: null });
    void (async () => {
      let settled = true, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await readEmpty(request, configuredLimits.readTimeoutMs, state.controller.signal);
        assertActive();
        settled = false;
        const operation = Promise.resolve().then(() => {
          assertActive();
          return identity.exchangeSession(token, metadata, assertActive);
        }).catch(error => {
          if (error instanceof RequestFailure) throw error;
          throw new RequestFailure(401);
        }).finally(() => { settled = true; });
        state.operation = operation;
        const exchanged = await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { cancel(); reject(new RequestFailure(408)); }, configuredLimits.operationTimeoutMs);
        })]);
        assertActive();
        const session = result(exchanged);
        assertActive();
        send(response, 201, { expiresInSeconds: session.expiresInSeconds }, session.token);
      } catch (error) { send(response, status(error), { code: CODE }); }
      finally {
        clearTimeout(timer);
        if (!settled && state.operation) void state.operation.then(release, release);
        else release();
      }
    })();
  };
  return Object.freeze({ handle, dispose() {
    if (disposed) return;
    disposed = true;
    for (const state of active.keys()) {
      state.cancelled = true; state.controller.abort();
      send(state.response, 503, { code: CODE });
    }
  } });
}
