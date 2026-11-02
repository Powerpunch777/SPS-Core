import { IncomingMessage, ServerResponse } from "node:http";
import { assertSpsNativeEnrollmentTlsRequest, SpsNativeSessionEnrollmentError,
  type createSpsNativeSessionEnrollment } from "./sps-native-session-enrollment.js";
import { SpsNativeEnrollmentError } from "./sps-native-enrollments.js";

type SessionAdapter = ReturnType<typeof createSpsNativeSessionEnrollment>;
type Adapter = Pick<SessionAdapter, "issue" | "completeFromTlsRequest">
  & Partial<Pick<SessionAdapter, "reconcileFromTlsRequest" | "renewFromTlsRequest">>;
type Options = { maxBodyBytes: number; readTimeoutMs: number; operationTimeoutMs: number; maxConcurrentRequests: number };
type Pending = { cancelled: boolean; response: ServerResponse; operation?: Promise<unknown> };
const ISSUE = "/sps-native/v1/enrollment/issue";
const COMPLETE = "/sps-native/v1/enrollment/complete";
const RECONCILE = "/sps-native/v1/enrollment/reconcile";
const RENEW = "/sps-native/v1/enrollment/renew";
const CODE = "native_enrollment_request_unavailable";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
class RequestFailure extends Error { constructor(readonly status: number) { super(CODE); } }
function fail(status: number): never { throw new RequestFailure(status); }

function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(400);
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length) fail(400);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = fields[key];
    if (!field?.enumerable || !("value" in field)) fail(400);
    result[key] = field.value;
  }
  return result;
}
function options(input: Options): Options {
  const value = data(input, ["maxBodyBytes", "readTimeoutMs", "operationTimeoutMs", "maxConcurrentRequests"]);
  for (const [key, min, max] of [["maxBodyBytes", 512, 8192], ["readTimeoutMs", 100, 10000],
    ["operationTimeoutMs", 500, 60000], ["maxConcurrentRequests", 1, 8]] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) {
      throw new TypeError("Invalid Native enrollment HTTP limits.");
    }
  }
  return Object.freeze(value as Options);
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  try {
    const bytes = Buffer.from(JSON.stringify(value));
    response.shouldKeepAlive = false;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length,
      "Cache-Control": "no-store", "Connection": "close", "X-Content-Type-Options": "nosniff" });
    response.end(bytes);
  } catch { response.destroy(); }
}
function failureStatus(error: unknown): number {
  if (error instanceof RequestFailure) return error.status;
  if (error instanceof SpsNativeSessionEnrollmentError) return 403;
  if (error instanceof SpsNativeEnrollmentError) return 409;
  return 503;
}
function length(request: IncomingMessage, maximum: number) {
  assertSpsNativeEnrollmentTlsRequest(request);
  if (request.rawHeaders.length > 64 || request.rawHeaders.reduce((sum, field) => sum + Buffer.byteLength(field), 0) > 16_384) fail(400);
  const lengths: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (name === "content-length") lengths.push(request.rawHeaders[index + 1]!);
    if (name === "content-encoding" || name === "transfer-encoding" || name.startsWith("sec-fetch-")) fail(400);
  }
  if (lengths.length !== 1 || !/^[1-9][0-9]{0,4}$/.test(lengths[0]!)) fail(400);
  const bytes = Number(lengths[0]);
  if (bytes > maximum) fail(413);
  return bytes;
}
function read(request: IncomingMessage, expected: number, timeoutMs: number, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    const finish = (error?: RequestFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.removeListener("data", onData); request.removeListener("end", onEnd);
      request.removeListener("error", onError); request.removeListener("aborted", onError);
      request.removeListener("close", onClose); signal.removeEventListener("abort", onAbort);
      if (error) { request.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk) || size + chunk.length > expected) return finish(new RequestFailure(413));
      size += chunk.length; chunks.push(chunk);
    };
    const onEnd = () => finish(size === expected && request.complete ? undefined : new RequestFailure(400));
    const onError = () => finish(new RequestFailure(400));
    const onClose = () => { if (!request.complete) onError(); };
    const onAbort = () => finish(new RequestFailure(503));
    const timer = setTimeout(() => finish(new RequestFailure(408)), timeoutMs);
    request.on("error", onError); request.on("aborted", onError); request.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("data", onData); request.once("end", onEnd);
    if (signal.aborted) onAbort();
  });
}
function input(bytes: Buffer, operation: string) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    // Private v1 wire format is compact JSON.stringify UTF-8. This rejects
    // duplicate/escaped duplicate keys without another permissive JSON parser.
    if (JSON.stringify(value) !== text) fail(400);
    const fields = data(value, operation === RENEW ? ["deviceKeyId", "requestPem"] : operation === RECONCILE ? ["enrollmentId"]
      : operation === ISSUE ? ["pairingId", "pairingSecret", "deviceKeyId", "requestPem"]
        : ["pairingId", "pairingSecret", "enrollmentId", "displayName"]);
    for (const [key, field] of Object.entries(fields)) {
      if (typeof field !== "string" || !field || field.length > (key === "requestPem" ? 3000 : 200)) fail(400);
    }
    return fields;
  } catch { fail(400); }
}
function project(value: unknown, operation: string) {
  try {
    if (operation === RENEW) {
      const fields = data(value, ["renewalId", "deviceId", "predecessorCertificateSha256", "certificate",
        "issuerCertificate", "certificateNotBefore", "certificateNotAfter"]);
      if (typeof fields.renewalId !== "string" || !UUID.test(fields.renewalId)
        || typeof fields.deviceId !== "string" || !UUID.test(fields.deviceId)
        || typeof fields.predecessorCertificateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(fields.predecessorCertificateSha256)) fail(503);
      for (const key of ["certificate", "issuerCertificate"] as const) {
        const field = fields[key];
        if (typeof field !== "string" || field.length < 1 || field.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(field)
          || Buffer.from(field, "base64url").length > 4096 || Buffer.from(field, "base64url").toString("base64url") !== field) fail(503);
      }
      for (const key of ["certificateNotBefore", "certificateNotAfter"] as const) {
        const field = fields[key];
        if (typeof field !== "string" || field.length !== 24 || new Date(field).toISOString() !== field) fail(503);
      }
      if (Date.parse(fields.certificateNotAfter as string) <= Date.parse(fields.certificateNotBefore as string)) fail(503);
      return fields;
    }
    if (operation === RECONCILE) {
      const fields = data(value, ["deviceId", "status"]);
      if (typeof fields.deviceId !== "string" || !UUID.test(fields.deviceId)
        || !["pending", "approved", "revoked"].includes(fields.status as string)) fail(503);
      return fields;
    }
    if (operation !== ISSUE) {
      if (!value || typeof value !== "object") fail(503);
      const fields = Object.getOwnPropertyDescriptors(value);
      if (!fields.id || !("value" in fields.id) || typeof fields.id.value !== "string" || !UUID.test(fields.id.value)
        || !fields.status || !("value" in fields.status) || fields.status.value !== "pending") fail(503);
      return { deviceId: fields.id.value as string, status: "pending" };
    }
    const fields = data(value, ["enrollmentId", "certificate", "issuerCertificate", "expiresAt"]);
    if (typeof fields.enrollmentId !== "string" || !UUID.test(fields.enrollmentId)) fail(503);
    for (const key of ["certificate", "issuerCertificate"] as const) {
      const field = fields[key];
      if (typeof field !== "string" || field.length < 1 || field.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(field)
        || Buffer.from(field, "base64url").toString("base64url") !== field) fail(503);
    }
    if (typeof fields.expiresAt !== "string" || fields.expiresAt.length !== 24
      || new Date(fields.expiresAt).toISOString() !== fields.expiresAt) fail(503);
    return fields;
  } catch { fail(503); }
}

/** Inactive dedicated Native enrollment handler. Opens no listener, mounts no
 * Core route, resolves no credentials and grants no Workspace/device approval.
 * An active slot is retained until actual work settles, even after timeout. */
export function createSpsNativeEnrollmentRequestHandler(adapter: Adapter, inputOptions: Options) {
  const limits = options(inputOptions);
  if (!adapter || typeof adapter.issue !== "function" || typeof adapter.completeFromTlsRequest !== "function") {
    throw new TypeError("Invalid Native enrollment adapter.");
  }
  let disposed = false;
  const active = new Map<Pending, AbortController>();
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // Incomplete requests may error after an early response or disposal.
    if (request instanceof IncomingMessage) request.on("error", () => {});
    if (response instanceof ServerResponse) {
      response.on("error", () => { if (!response.destroyed) response.destroy(); });
    }
    let size: number;
    try {
      if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) fail(403);
      if (disposed) fail(503);
      if (request.url !== ISSUE && request.url !== COMPLETE && request.url !== RECONCILE && request.url !== RENEW) fail(404);
      if (request.url === RECONCILE && typeof adapter.reconcileFromTlsRequest !== "function") fail(404);
      if (request.url === RENEW && typeof adapter.renewFromTlsRequest !== "function") fail(404);
      size = length(request, limits.maxBodyBytes);
      if (active.size >= limits.maxConcurrentRequests) fail(429);
    } catch (error) { send(response, failureStatus(error), { code: CODE }); return; }
    const state: Pending = { cancelled: false, response };
    const controller = new AbortController();
    active.set(state, controller);
    const assertActive = () => {
      if (disposed || state.cancelled || request.aborted || request.socket.destroyed || response.destroyed) fail(503);
    };
    const onClose = () => { if (!response.writableFinished) { state.cancelled = true; controller.abort(); } };
    response.once("close", onClose);
    const release = () => { active.delete(state); response.removeListener("close", onClose); };
    void (async () => {
      let settled = true, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const fields = input(await read(request, size, limits.readTimeoutMs, controller.signal), request.url!);
        assertActive();
        settled = false;
        const operation = Promise.resolve().then<unknown>(() => {
          assertActive();
          if (request.url === RENEW) {
            if (typeof adapter.renewFromTlsRequest !== "function") fail(404);
            return adapter.renewFromTlsRequest(request,
              fields as Parameters<NonNullable<Adapter["renewFromTlsRequest"]>>[1], assertActive);
          }
          if (request.url === RECONCILE) {
            if (typeof adapter.reconcileFromTlsRequest !== "function") fail(404);
            return adapter.reconcileFromTlsRequest(request,
              fields as Parameters<NonNullable<Adapter["reconcileFromTlsRequest"]>>[1], assertActive);
          }
          return request.url === ISSUE
            ? adapter.issue(request, fields as Parameters<Adapter["issue"]>[1], assertActive)
            : adapter.completeFromTlsRequest(request, fields as Parameters<Adapter["completeFromTlsRequest"]>[1], assertActive);
        }).finally(() => { settled = true; });
        state.operation = operation;
        const result = await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { state.cancelled = true; reject(new RequestFailure(408)); }, limits.operationTimeoutMs);
        })]);
        assertActive();
        send(response, 200, project(result, request.url!));
      } catch (error) { send(response, failureStatus(error), { code: CODE }); }
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
    for (const [state, controller] of active) {
      state.cancelled = true; controller.abort();
      send(state.response, 503, { code: CODE });
    }
  } });
}
