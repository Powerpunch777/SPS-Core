import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { createSpsNativeMainIngressPeer } from "./sps-native-enrollments.js";
import type { SpsNativeParentEnrollment } from "./sps-native-parent-enrollment.js";

const REQUEST = "sps.native.parent-ingress.request";
const RESPONSE = "sps.native.parent-ingress.response";
const CANCEL = "sps.native.parent-ingress.cancel";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{64}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_REQUESTS = 4096;
const MAX_PENDING = 2;
const FAILURE = "native_ingress_unavailable";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "exchangeSession" | "resolveNativeEnrollmentSessionFromHeaders">;
type Channel = {
  connected?: boolean;
  send: (...args: unknown[]) => unknown;
  on(event: "message" | "disconnect" | "exit", listener: (...args: unknown[]) => void): unknown;
  removeListener(event: "message" | "disconnect" | "exit", listener: (...args: unknown[]) => void): unknown;
};
type Limits = { maxPending?: number; maxRequests?: number; assertCurrent?: () => void };
type Op = "identity" | "session.exchange" | "enrollment.issue" | "enrollment.complete" | "enrollment.reconcile";
type Pending = { controller: AbortController; cancelled: boolean };

function fail(): never { throw new Error(FAILURE); }

function record(value: unknown, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) fail();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    out[key] = descriptor.value;
  }
  return out;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function csrText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 3000
    && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
}

function parse(value: unknown): { id: string; operation: Op; body: Record<string, unknown> | null;
  credential?: Record<string, unknown>; transport: Record<string, unknown> } {
  const top = record(value, ["v", "kind", "id", "operation", "request"]);
  if (top.v !== 1 || top.kind !== REQUEST || typeof top.id !== "string" || !UUID.test(top.id)) fail();
  const operation = top.operation;
  if (!["identity", "session.exchange", "enrollment.issue", "enrollment.complete", "enrollment.reconcile"].includes(operation as string)) fail();
  const op = operation as Op;
  const needsCredential = op !== "identity";
  const request = record(top.request, ["body", "transport", "credential"], ["body", "transport"]);
  if (Object.hasOwn(request, "credential") !== needsCredential) fail();
  const transport = record(request.transport, ["tlsVersion", "sessionReused", "remoteAddress", "peerCertificateDer"],
    ["tlsVersion", "sessionReused", "remoteAddress", ...(op === "enrollment.complete" || op === "enrollment.reconcile" ? ["peerCertificateDer"] : [])]);
  if (transport.tlsVersion !== "TLSv1.3" || transport.sessionReused !== false
    || !(transport.remoteAddress === null || text(transport.remoteAddress, 128))) fail();
  if (op === "enrollment.complete" || op === "enrollment.reconcile") {
    if (typeof transport.peerCertificateDer !== "string" || transport.peerCertificateDer.length > 5462
      || !/^[A-Za-z0-9_-]+$/.test(transport.peerCertificateDer)) fail();
    const der = Buffer.from(transport.peerCertificateDer, "base64url");
    if (der.length < 1 || der.length > 4096 || der.toString("base64url") !== transport.peerCertificateDer) fail();
  } else if (Object.hasOwn(transport, "peerCertificateDer")) fail();

  let body: Record<string, unknown> | null;
  if (op === "identity" || op === "session.exchange") {
    if (request.body !== null) fail();
    body = null;
  } else if (op === "enrollment.issue") {
    body = record(request.body, ["pairingId", "pairingSecret", "deviceKeyId", "requestPem"]);
    if (!text(body.pairingId, 200) || !text(body.pairingSecret, 200) || !text(body.deviceKeyId, 200)
      || !csrText(body.requestPem)) fail();
  } else if (op === "enrollment.complete") {
    body = record(request.body, ["pairingId", "pairingSecret", "enrollmentId", "displayName"]);
    if (!text(body.pairingId, 200) || !text(body.pairingSecret, 200) || !text(body.enrollmentId, 200)
      || !text(body.displayName, 200)) fail();
  } else {
    body = record(request.body, ["enrollmentId"]);
    if (!text(body.enrollmentId, 200)) fail();
  }
  let credential: Record<string, unknown> | undefined;
  if (op === "session.exchange") {
    credential = record(request.credential, ["accessToken"]);
    if (!text(credential.accessToken, 8191) || !JWT.test(credential.accessToken)) fail();
  } else if (needsCredential) {
    credential = record(request.credential, ["sessionCookie"]);
    if (!text(credential.sessionCookie, 256)) fail();
    const match = /^sps_identity_session=([A-Za-z0-9_-]{64})$/.exec(credential.sessionCookie);
    if (!match || !TOKEN.test(match[1]!)) fail();
  }
  return { id: top.id, operation: op, body, credential, transport };
}

export type SpsNativeParentIngressOptions = { maxPending?: number; maxRequests?: number; assertCurrent?: () => void };

/** Private direct-child IPC adapter. It exposes no HTTP listener or SDK contract. */
export function createSpsNativeParentIngress(
  identity: Identity,
  enrollment: SpsNativeParentEnrollment,
  limits: Limits = {},
  channelValue: unknown = process,
) {
  const opts = record(limits, ["maxPending", "maxRequests", "assertCurrent"], []);
  const maxPending = opts.maxPending ?? MAX_PENDING;
  const maxRequests = opts.maxRequests ?? MAX_REQUESTS;
  if (!Number.isSafeInteger(maxPending) || (maxPending as number) < 1 || (maxPending as number) > MAX_PENDING
    || !Number.isSafeInteger(maxRequests) || (maxRequests as number) < 1 || (maxRequests as number) > MAX_REQUESTS
    || !identity || typeof identity.exchangeSession !== "function"
    || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function"
    || !enrollment || typeof enrollment.assertActive !== "function" || !enrollment.identity || !enrollment.service
    || !channelValue || typeof (channelValue as Channel).send !== "function" || typeof (channelValue as Channel).on !== "function"
    || typeof (channelValue as Channel).removeListener !== "function") throw new TypeError("Invalid SPS Native parent ingress configuration.");
  const channel = channelValue as Channel;

  let disposed = false;
  let accepted = 0;
  const pending = new Map<string, Pending>();
  const seen = new Set<string>();
  const assertAvailable = () => {
    if (disposed || channel.connected === false) fail();
    enrollment.assertActive();
    if (opts.assertCurrent !== undefined) {
      if (typeof opts.assertCurrent !== "function") fail();
      const current = opts.assertCurrent();
      if (current && typeof (current as { then?: unknown }).then === "function") {
        void Promise.resolve(current).catch(dispose);
        fail();
      }
      if (current !== undefined) fail();
    }
  };
  const send = (id: string, ok: boolean, result?: unknown) => {
    if (disposed || channel.connected === false) return;
    try {
      channel.send(ok
        ? { v: 1, kind: RESPONSE, id, ok: true, result }
        : { v: 1, kind: RESPONSE, id, ok: false, errorCode: FAILURE },
      (error: Error | null) => { if (error) dispose(); });
    } catch { dispose(); }
  };
  const execute = async (request: ReturnType<typeof parse>, state: Pending): Promise<unknown> => {
    const assertActive = () => {
      assertAvailable();
      if (state.cancelled || state.controller.signal.aborted) fail();
    };
    assertActive();
    if (request.operation === "identity") return enrollment.identity;
    if (request.operation === "session.exchange") {
      const exchanged = await identity.exchangeSession(request.credential!.accessToken as string,
        { ipAddress: request.transport.remoteAddress as string | null, userAgent: null }, assertActive);
      assertActive();
      const value = record(exchanged, ["profile", "token", "expiresInSeconds"]);
      if (!TOKEN.test(String(value.token)) || value.expiresInSeconds !== SESSION_TTL_SECONDS) fail();
      return { token: value.token, expiresInSeconds: value.expiresInSeconds };
    }
    const cookie = request.credential!.sessionCookie as string;
    const session = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie }));
    assertActive();
    if (!session || !text(session.userId, 200) || typeof session.authorizeInTransaction !== "function") fail();
    const userId = session.userId;
    const authorize = async (tx: Parameters<typeof session.authorizeInTransaction>[0], requestedUserId: string) => {
      assertActive();
      if (requestedUserId !== userId) fail();
      await session.authorizeInTransaction(tx, requestedUserId);
      assertActive();
    };
    let result: unknown;
    if (request.operation === "enrollment.issue") {
      result = await enrollment.service.issue({ ...request.body!, userId } as never, authorize);
    } else {
      const proof = request.operation === "enrollment.complete"
        ? createSpsNativeMainIngressPeer({ protocol: "TLSv1.3", resumed: false,
          certificateDer: Buffer.from(request.transport.peerCertificateDer as string, "base64url"), assertActive })
        : createSpsNativeMainIngressPeer({ protocol: "TLSv1.3", resumed: false,
          certificateDer: Buffer.from(request.transport.peerCertificateDer as string, "base64url"), assertActive });
      result = request.operation === "enrollment.complete"
        ? await enrollment.service.completeFromTlsPeer(proof, { ...request.body!, userId } as never, authorize)
        : await enrollment.service.reconcileFromTlsPeer(proof, { ...request.body!, userId } as never, authorize);
      if (request.operation === "enrollment.complete") {
        if (!result || typeof result !== "object" || Array.isArray(result)
          || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) fail();
        const completed = Object.getOwnPropertyDescriptors(result);
        const id = completed.id, status = completed.status;
        if (!id?.enumerable || !("value" in id) || !text(id.value, 200)
          || !status?.enumerable || !("value" in status) || status.value !== "pending") fail();
        result = { deviceId: id.value, status: status.value };
      }
    }
    assertActive();
    return result;
  };
  const onMessage = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const kind = Object.getOwnPropertyDescriptor(raw, "kind");
    if (!kind || !("value" in kind)) return;
    if (kind.value === CANCEL) {
      try {
        const cancel = record(raw, ["v", "kind", "id"]);
        if (cancel.v !== 1 || typeof cancel.id !== "string" || !UUID.test(cancel.id)) return dispose();
        const state = pending.get(cancel.id);
        if (state) { state.cancelled = true; state.controller.abort(); }
      } catch { dispose(); }
      return;
    }
    if (kind.value !== REQUEST) return;
    let request: ReturnType<typeof parse>;
    try {
      request = parse(raw);
      if (seen.has(request.id)) { dispose(); return; }
      if (accepted >= (maxRequests as number) || pending.size >= (maxPending as number)) fail();
    } catch {
      const idField = Object.getOwnPropertyDescriptor(raw, "id");
      if (idField && "value" in idField && typeof idField.value === "string" && pending.has(idField.value)) {
        dispose();
        return;
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, "id");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && UUID.test(descriptor.value)) {
        send(descriptor.value, false);
      } else dispose();
      return;
    }
    seen.add(request.id); accepted++;
    const state: Pending = { controller: new AbortController(), cancelled: false };
    pending.set(request.id, state);
    void execute(request, state).then(result => send(request.id, true, result), () => send(request.id, false))
      .finally(() => pending.delete(request.id));
  };
  const onDisconnect = () => dispose();
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  channel.on("exit", onDisconnect);
  function dispose() {
    if (disposed) return;
    disposed = true;
    channel.removeListener("message", onMessage);
    channel.removeListener("disconnect", onDisconnect);
    channel.removeListener("exit", onDisconnect);
    for (const state of pending.values()) { state.cancelled = true; state.controller.abort(); }
  }
  try { assertAvailable(); } catch { dispose(); throw new Error(FAILURE); }
  return Object.freeze({ assertAvailable, dispose });
}
