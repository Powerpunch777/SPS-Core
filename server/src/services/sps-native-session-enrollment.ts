import { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { SpsNativeEnrollmentError, type spsNativeEnrollmentService } from "./sps-native-enrollments.js";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "resolveNativeEnrollmentSessionFromHeaders">;
type Enrollment = Pick<ReturnType<typeof spsNativeEnrollmentService>, "issue" | "completeFromTlsPeer">;
type IssueBody = { pairingId: string; pairingSecret: string; deviceKeyId: string; requestPem: string };
type CompleteBody = { pairingId: string; pairingSecret: string; enrollmentId: string; displayName: string };

export class SpsNativeSessionEnrollmentError extends Error {
  readonly code = "native_enrollment_request_unavailable";
  readonly status = 403;
  constructor() { super("A current SPS sign-in over the Native TLS connection is required. Existing credentials were not replaced."); }
}
function deny(): never { throw new SpsNativeSessionEnrollmentError(); }

function body(value: unknown, keys: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) deny();
  const result: Record<string, string> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string"
      || !descriptor.value || descriptor.value.length > (key === "requestPem" ? 3000 : 200)) deny();
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function tlsRequest(request: IncomingMessage): { socket: TLSSocket; headers: Headers } {
  if (!(request instanceof IncomingMessage) || request.method !== "POST"
    || !(request.socket instanceof TLSSocket) || request.socket.destroyed || !request.socket.encrypted
    || request.socket.getProtocol() !== "TLSv1.3" || request.socket.isSessionReused()) deny();
  // Only the Native Main client calls this private adapter. Browser mutations
  // must not borrow a session cookie; no Origin/Referer-derived trust is used.
  if (request.headers.origin !== undefined || request.headers.referer !== undefined
    || request.headers.authorization !== undefined
    || request.headers["sec-fetch-site"] !== undefined
    || typeof request.headers["content-type"] !== "string"
    || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"])) deny();
  const cookieHeaders: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "cookie") cookieHeaders.push(request.rawHeaders[index + 1] ?? "");
  }
  if (cookieHeaders.length !== 1 || cookieHeaders[0]!.length > 8192) deny();
  return { socket: request.socket, headers: new Headers({ cookie: cookieHeaders[0]! }) };
}

/** Explicit trusted composition only: no listener, route or session is created.
 * Identity must be the configured SPS Identity instance, not an actor/body shim.
 * The future ingress still owns body-size/time/concurrency limits and Host pins.
 */
export function createSpsNativeSessionEnrollment(identity: Identity, enrollment: Enrollment) {
  if (!identity || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function"
    || !enrollment || typeof enrollment.issue !== "function" || typeof enrollment.completeFromTlsPeer !== "function") {
    throw new TypeError("Invalid SPS Native session enrollment configuration.");
  }
  async function session(request: IncomingMessage) {
    const captured = tlsRequest(request);
    const current = await identity.resolveNativeEnrollmentSessionFromHeaders(captured.headers);
    if (!current || typeof current.userId !== "string" || !current.userId || current.userId.length > 200
      || /[\u0000-\u001f\u007f]/.test(current.userId) || typeof current.authorizeInTransaction !== "function"
      || tlsRequest(request).socket !== captured.socket) deny();
    return { ...captured, current };
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof SpsNativeEnrollmentError) throw error; deny(); }
  }
  return Object.freeze({
    issue(request: IncomingMessage, input: IssueBody) {
      return safe(async () => {
        const value = body(input, ["pairingId", "pairingSecret", "deviceKeyId", "requestPem"]);
        const { current } = await session(request);
        return await enrollment.issue({ pairingId: value.pairingId!, pairingSecret: value.pairingSecret!,
          deviceKeyId: value.deviceKeyId!, requestPem: value.requestPem!, userId: current.userId }, current.authorizeInTransaction);
      });
    },
    completeFromTlsRequest(request: IncomingMessage, input: CompleteBody) {
      return safe(async () => {
        const value = body(input, ["pairingId", "pairingSecret", "enrollmentId", "displayName"]);
        const { socket, current } = await session(request);
        return await enrollment.completeFromTlsPeer(socket, { pairingId: value.pairingId!, pairingSecret: value.pairingSecret!,
          enrollmentId: value.enrollmentId!, displayName: value.displayName!, userId: current.userId }, current.authorizeInTransaction);
      });
    },
  });
}
