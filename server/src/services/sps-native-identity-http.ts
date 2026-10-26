import { createHash, X509Certificate } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";

export type SpsNativeIdentityInspection = {
  hostId: string;
  serverSpkiSha256: string;
  issuerSpkiSha256: string;
  issuerCertificate: string;
};

export type SpsNativeIdentityHttpOptions = {
  readTimeoutMs: number;
  operationTimeoutMs: number;
  maxConcurrentRequests: number;
};

type Pending = {
  cancelled: boolean;
  request: IncomingMessage;
  response: ServerResponse;
  socket: TLSSocket;
  operation?: Promise<unknown>;
};

const PATH = "/sps-native/v1/identity";
const CODE = "native_identity_unavailable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PIN = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

class RequestFailure extends Error {
  constructor(readonly status: number) { super(CODE); }
}

function fail(status: number): never { throw new RequestFailure(status); }

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) throw new TypeError();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new TypeError();
    result[key] = descriptor.value;
  }
  return result;
}

function limits(input: SpsNativeIdentityHttpOptions): SpsNativeIdentityHttpOptions {
  let value: Record<string, unknown>;
  try { value = ownData(input, ["readTimeoutMs", "operationTimeoutMs", "maxConcurrentRequests"]); }
  catch { throw new TypeError("Invalid Native identity HTTP limits."); }
  for (const [key, minimum, maximum] of [["readTimeoutMs", 100, 10_000], ["operationTimeoutMs", 500, 60_000],
    ["maxConcurrentRequests", 1, 8]] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < minimum || (value[key] as number) > maximum) {
      throw new TypeError("Invalid Native identity HTTP limits.");
    }
  }
  return Object.freeze(value as SpsNativeIdentityHttpOptions);
}

function tlsSocket(request: IncomingMessage): TLSSocket {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.destroyed || !socket.encrypted
    || socket.getProtocol() !== "TLSv1.3" || socket.isSessionReused()) fail(403);
  return socket;
}

function requestHeaders(request: IncomingMessage): void {
  const { rawHeaders } = request;
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > 64
    || rawHeaders.reduce((sum, field) => sum + Buffer.byteLength(field), 0) > 16_384) fail(400);

  const seen = new Set<string>();
  const lengths: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1]!;
    if (seen.has(name)) fail(400);
    seen.add(name);

    if (name === "content-length") lengths.push(value);
    if (name === "authorization" || name === "cookie" || name === "origin" || name === "referer"
      || name.startsWith("sec-fetch-") || name.startsWith("proxy-")
      || name === "forwarded" || name.startsWith("x-forwarded-")
      || name === "transfer-encoding" || name === "content-encoding" || name === "trailer") fail(403);
  }
  if (lengths.length !== 1 || lengths[0] !== "0") fail(400);
}

function readEmpty(request: IncomingMessage, timeoutMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: RequestFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onError);
      request.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
      if (error) { request.pause(); reject(error); }
      else resolve();
    };
    const onData = () => finish(new RequestFailure(400));
    const onEnd = () => finish(request.complete ? undefined : new RequestFailure(400));
    const onError = () => finish(new RequestFailure(400));
    const onClose = () => request.complete ? onEnd() : onError();
    const onAbort = () => finish(new RequestFailure(503));
    const timer = setTimeout(() => finish(new RequestFailure(408)), timeoutMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.on("error", onError);
    request.once("aborted", onError);
    request.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function publicIdentity(value: unknown, socket: TLSSocket): SpsNativeIdentityInspection {
  try {
    const fields = ownData(value, ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "issuerCertificate"]);
    const { hostId, serverSpkiSha256, issuerSpkiSha256, issuerCertificate } = fields;
    if (typeof hostId !== "string" || !UUID.test(hostId)
      || typeof serverSpkiSha256 !== "string" || !PIN.test(serverSpkiSha256)
      || typeof issuerSpkiSha256 !== "string" || !PIN.test(issuerSpkiSha256)
      || typeof issuerCertificate !== "string" || issuerCertificate.length > 5462
      || !BASE64URL.test(issuerCertificate)) fail(503);

    const der = Buffer.from(issuerCertificate, "base64url");
    if (der.length < 1 || der.length > 4096 || der.toString("base64url") !== issuerCertificate) fail(503);
    const issuer = new X509Certificate(der);
    const issuerSpki = issuer.publicKey.export({ format: "der", type: "spki" });
    const issuerPin = createHash("sha256").update(issuerSpki).digest("hex");
    const commonNames = issuer.subject.split(/\r?\n/).filter(line => line.startsWith("CN="));
    const now = Date.now();
    if (!issuer.ca || issuer.subject !== issuer.issuer || !issuer.verify(issuer.publicKey)
      || commonNames.length !== 1 || commonNames[0] !== `CN=SPS Member Issuer ${hostId}`
      || !Number.isFinite(Date.parse(issuer.validFrom)) || !Number.isFinite(Date.parse(issuer.validTo))
      || now < Date.parse(issuer.validFrom) || now >= Date.parse(issuer.validTo)
      || issuerPin !== issuerSpkiSha256 || issuerPin === serverSpkiSha256 || !issuer.raw.equals(der)) fail(503);

    const localCertificate = socket.getX509Certificate();
    if (!localCertificate) fail(503);
    const localSpki = localCertificate.publicKey.export({ format: "der", type: "spki" });
    if (createHash("sha256").update(localSpki).digest("hex") !== serverSpkiSha256) fail(503);

    return { hostId, serverSpkiSha256, issuerSpkiSha256, issuerCertificate };
  } catch { fail(503); }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  try {
    const bytes = Buffer.from(JSON.stringify(body));
    response.shouldKeepAlive = false;
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": bytes.length,
      "Cache-Control": "no-store",
      Connection: "close",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(bytes);
  } catch { response.destroy(); }
}

function failureStatus(error: unknown): number {
  return error instanceof RequestFailure ? error.status : 503;
}

/** Inactive public Native identity handler. It opens no socket and authenticates no account. */
export function createSpsNativeIdentityRequestHandler(
  inspect: () => Promise<SpsNativeIdentityInspection>,
  inputLimits: SpsNativeIdentityHttpOptions,
  currentGuard?: () => void,
) {
  const configuredLimits = limits(inputLimits);
  if (typeof inspect !== "function" || (currentGuard !== undefined && typeof currentGuard !== "function")) {
    throw new TypeError("Invalid Native identity inspection configuration.");
  }

  let disposed = false;
  const active = new Map<Pending, AbortController>();
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (request instanceof IncomingMessage) request.on("error", () => {});
    if (response instanceof ServerResponse) response.on("error", () => { if (!response.destroyed) response.destroy(); });

    let socket: TLSSocket;
    try {
      if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) fail(403);
      if (disposed) fail(503);
      if (request.url !== PATH) fail(404);
      if (request.method !== "POST") fail(403);
      socket = tlsSocket(request);
      requestHeaders(request);
      if (active.size >= configuredLimits.maxConcurrentRequests) fail(429);
    } catch (error) { send(response, failureStatus(error), { code: CODE }); return; }

    const state: Pending = { cancelled: false, request, response, socket };
    const controller = new AbortController();
    active.set(state, controller);
    const assertTransportActive = () => {
      if (disposed || state.cancelled || request.aborted || request.socket !== socket || socket.destroyed
        || response.destroyed || response.writableEnded) fail(503);
      if (tlsSocket(request) !== socket) fail(503);
    };
    const assertActive = () => {
      assertTransportActive();
      let result: void;
      try { result = currentGuard?.(); } catch { fail(503); }
      if (result !== undefined) {
        if ((typeof result === "object" && result !== null) || typeof result === "function") {
          void Promise.resolve(result).catch(() => {});
        }
        fail(503);
      }
      assertTransportActive();
    };
    const cancel = () => { state.cancelled = true; controller.abort(); };
    const onResponseClose = () => { if (!response.writableFinished) cancel(); };
    const onSocketClose = () => cancel();
    response.once("close", onResponseClose);
    socket.once("close", onSocketClose);
    const release = () => {
      active.delete(state);
      response.removeListener("close", onResponseClose);
      socket.removeListener("close", onSocketClose);
    };

    void (async () => {
      let settled = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await readEmpty(request, configuredLimits.readTimeoutMs, controller.signal);
        assertActive();
        settled = false;
        const operation = Promise.resolve().then(() => {
          assertActive();
          return inspect();
        }).catch(error => {
          if (error instanceof RequestFailure) throw error;
          throw new RequestFailure(503);
        }).finally(() => { settled = true; });
        state.operation = operation;
        const inspected = await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { cancel(); reject(new RequestFailure(408)); }, configuredLimits.operationTimeoutMs);
        })]);
        assertActive();
        const identity = publicIdentity(inspected, socket);
        assertActive();
        const localCertificate = socket.getX509Certificate();
        if (!localCertificate || createHash("sha256").update(localCertificate.publicKey.export({
          format: "der", type: "spki",
        })).digest("hex") !== identity.serverSpkiSha256) fail(503);
        assertActive();
        send(response, 200, identity);
      } catch (error) { send(response, failureStatus(error), { code: CODE }); }
      finally {
        clearTimeout(timer);
        if (!settled && state.operation) void state.operation.then(release, release);
        else release();
      }
    })();
  };

  return Object.freeze({
    handle,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [state, controller] of active) {
        state.cancelled = true;
        controller.abort();
        send(state.response, 503, { code: CODE });
      }
    },
  });
}
