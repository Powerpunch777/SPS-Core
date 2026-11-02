import { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { SpsNativeEnrollmentError, type spsNativeEnrollmentService } from "./sps-native-enrollments.js";
import type { SpsNativePairingAuthorizer } from "./sps-native-pairings.js";
import type { createSpsNativeMemberRenewalService } from "./sps-native-member-renewals.js";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "resolveNativeEnrollmentSessionFromHeaders">;
type Enrollment = Pick<ReturnType<typeof spsNativeEnrollmentService>, "issue" | "completeFromTlsPeer">
  & Partial<Pick<ReturnType<typeof spsNativeEnrollmentService>, "reconcileFromTlsPeer">>;
type IssueBody = { pairingId: string; pairingSecret: string; deviceKeyId: string; requestPem: string };
type CompleteBody = { pairingId: string; pairingSecret: string; enrollmentId: string; displayName: string };
type ReconcileBody = { enrollmentId: string };
type RenewBody = { deviceKeyId: string; requestPem: string };
type Renewal = Pick<ReturnType<typeof createSpsNativeMemberRenewalService>, "renewFromTlsPeer">;

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
  // Reject browser mutations; these checks alone do not authenticate Desktop
  // Main. Actual user/session authority is resolved separately below.
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

/** Private ingress preflight, not proof of a Main client or a current session. */
export function assertSpsNativeEnrollmentTlsRequest(request: IncomingMessage): void { tlsRequest(request); }

/** Explicit trusted composition only: no listener, route or session is created.
 * Identity must be the configured SPS Identity instance, not an actor/body shim.
 * The optional dedicated handler supplies body/time/concurrency limits. The
 * future listener still owns TLS/socket admission, session exchange and pins.
 */
export function createSpsNativeSessionEnrollment(identity: Identity, enrollment: Enrollment, renewal?: Renewal) {
  if (!identity || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function"
    || !enrollment || typeof enrollment.issue !== "function" || typeof enrollment.completeFromTlsPeer !== "function") {
    throw new TypeError("Invalid SPS Native session enrollment configuration.");
  }
  if (renewal !== undefined && typeof renewal.renewFromTlsPeer !== "function") {
    throw new TypeError("Invalid SPS Native renewal configuration.");
  }
  async function session(request: IncomingMessage, assertRequestActive: () => void) {
    if (typeof assertRequestActive !== "function") deny();
    assertRequestActive();
    const captured = tlsRequest(request);
    const current = await identity.resolveNativeEnrollmentSessionFromHeaders(captured.headers);
    if (!current || typeof current.userId !== "string" || !current.userId || current.userId.length > 200
      || /[\u0000-\u001f\u007f]/.test(current.userId) || typeof current.authorizeInTransaction !== "function"
      || tlsRequest(request).socket !== captured.socket) deny();
    const recheck = () => {
      assertRequestActive();
      if (tlsRequest(request).socket !== captured.socket) deny();
    };
    recheck();
    const authorize: SpsNativePairingAuthorizer = async (tx, userId) => {
      recheck();
      await current.authorizeInTransaction(tx, userId);
      recheck();
    };
    return { ...captured, current, authorize, recheck };
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof SpsNativeEnrollmentError) throw error; deny(); }
  }
  return Object.freeze({
    ...(renewal ? {
      renewFromTlsRequest(request: IncomingMessage, input: RenewBody, assertRequestActive: () => void = () => {}) {
        return safe(async () => {
          const value = body(input, ["deviceKeyId", "requestPem"]);
          const { socket, current, authorize, recheck } = await session(request, assertRequestActive);
          const result = await renewal.renewFromTlsPeer(socket, {
            deviceKeyId: value.deviceKeyId!, requestPem: value.requestPem!, userId: current.userId,
          }, authorize);
          recheck();
          return result;
        });
      },
    } : {}),
    reconcileFromTlsRequest(request: IncomingMessage, input: ReconcileBody, assertRequestActive: () => void = () => {}) {
      return safe(async () => {
        const value = body(input, ["enrollmentId"]);
        if (typeof enrollment.reconcileFromTlsPeer !== "function") deny();
        const { socket, current, authorize, recheck } = await session(request, assertRequestActive);
        const result = await enrollment.reconcileFromTlsPeer(socket, {
          enrollmentId: value.enrollmentId!, userId: current.userId,
        }, authorize);
        recheck();
        return result;
      });
    },
    issue(request: IncomingMessage, input: IssueBody, assertRequestActive: () => void = () => {}) {
      return safe(async () => {
        const value = body(input, ["pairingId", "pairingSecret", "deviceKeyId", "requestPem"]);
        const { current, authorize, recheck } = await session(request, assertRequestActive);
        const result = await enrollment.issue({ pairingId: value.pairingId!, pairingSecret: value.pairingSecret!,
          deviceKeyId: value.deviceKeyId!, requestPem: value.requestPem!, userId: current.userId }, authorize);
        recheck();
        return result;
      });
    },
    completeFromTlsRequest(request: IncomingMessage, input: CompleteBody, assertRequestActive: () => void = () => {}) {
      return safe(async () => {
        const value = body(input, ["pairingId", "pairingSecret", "enrollmentId", "displayName"]);
        const { socket, current, authorize, recheck } = await session(request, assertRequestActive);
        const result = await enrollment.completeFromTlsPeer(socket, { pairingId: value.pairingId!, pairingSecret: value.pairingSecret!,
          enrollmentId: value.enrollmentId!, displayName: value.displayName!, userId: current.userId }, authorize);
        recheck();
        return result;
      });
    },
  });
}
