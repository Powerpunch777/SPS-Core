import { createHash, randomUUID } from "node:crypto";

const REQUEST_KIND = "sps.native.signer.request" as const;
const RESPONSE_KIND = "sps.native.signer.response" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_CERTIFICATE_BYTES = 4096;
const MAX_REQUEST_PEM_LENGTH = 3000;
const MAX_SIGNING_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 253_402_300_799_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING = 2;

type Operation = "inspect" | "sign";
type SignPayload = {
  hostId: string;
  serverSpkiSha256: string;
  issuerSpkiSha256: string;
  deviceKeyId: string;
  requestPem: string;
  notBefore: number;
  notAfter: number;
};
type InspectResult = {
  hostId: string;
  serverSpkiSha256: string;
  issuerSpkiSha256: string;
  issuerCertificate: string;
};
type SignResult = { certificate: string; requestSha256: string };
type PendingRequest = {
  operation: Operation;
  resolve: (value: InspectResult | SignResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer: ReturnType<typeof setTimeout>;
};
type IpcChannel = {
  connected: boolean;
  send: (...args: unknown[]) => unknown;
  on: (event: "message" | "disconnect" | "exit", listener: (...args: unknown[]) => void) => unknown;
  removeListener: (event: "message" | "disconnect" | "exit", listener: (...args: unknown[]) => void) => unknown;
};

export type SpsNativeParentSignerClientOptions = {
  timeoutMs?: number;
  maxPending?: number;
};

export type SpsNativeParentSignerRequest = SignPayload & { signal?: AbortSignal };

export type SpsNativeParentSignerClient = {
  inspect(options?: { signal?: AbortSignal }): Promise<InspectResult>;
  sign(input: SpsNativeParentSignerRequest): Promise<SignResult>;
  isAvailable(): boolean;
  assertAvailable(): void;
  dispose(): void;
};

function invalidInput(): TypeError {
  return new TypeError("Invalid SPS Native signer request.");
}

function unavailable(): Error {
  return Object.assign(new Error("SPS Native signer is unavailable."), { code: "native_signer_unavailable" });
}

function clientError(code: "native_signer_busy" | "native_signer_timeout" | "native_signer_aborted"): Error {
  const messages = {
    native_signer_busy: "SPS Native signer has too many pending requests.",
    native_signer_timeout: "SPS Native signer request timed out.",
    native_signer_aborted: "SPS Native signer request was aborted.",
  } as const;
  return Object.assign(new Error(messages[code]), { code });
}

function ownRecord(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidInput();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > allowedKeys.length || keys.some(key => typeof key !== "string" || !allowedKeys.includes(key))) {
      throw invalidInput();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") throw invalidInput();
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidInput();
      result[key] = descriptor.value;
    }
    if (requiredKeys.some(key => !Object.hasOwn(result, key))) throw invalidInput();
    return result;
  } catch {
    throw invalidInput();
  }
}

function correlationId(value: unknown): string | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    return typeof descriptor.value === "string" && UUID.test(descriptor.value) ? descriptor.value : null;
  } catch {
    return null;
  }
}

function signalValue(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  try {
    if (!(value instanceof AbortSignal)) throw invalidInput();
    return value;
  } catch {
    throw invalidInput();
  }
}

function isAborted(signal: AbortSignal): boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (!getter) throw invalidInput();
  return getter.call(signal);
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.addEventListener.call(signal, "abort", listener, { once: true });
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  EventTarget.prototype.removeEventListener.call(signal, "abort", listener);
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalidInput();
  return value;
}

function requirePin(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw invalidInput();
  return value;
}

function requireRequestPem(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_REQUEST_PEM_LENGTH) throw invalidInput();
  const body = value
    .replace(/^-----BEGIN CERTIFICATE REQUEST-----\n/, "")
    .replace(/\n-----END CERTIFICATE REQUEST-----\n$/, "");
  if (!/^[A-Za-z0-9+/=\n]+$/.test(body)) throw invalidInput();
  const bytes = Buffer.from(body.replaceAll("\n", ""), "base64");
  if (bytes.length < 1 || bytes.length > 2048) throw invalidInput();
  const encoded = bytes.toString("base64").match(/.{1,64}/g)?.join("\n");
  if (!encoded || value !== `-----BEGIN CERTIFICATE REQUEST-----\n${encoded}\n-----END CERTIFICATE REQUEST-----\n`) {
    throw invalidInput();
  }
  return value;
}

function requireCertificate(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidInput();
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_BYTES || bytes.toString("base64url") !== value) {
    throw invalidInput();
  }
  return value;
}

function validateSignPayload(value: Record<string, unknown>): SignPayload {
  const hostId = requireUuid(value.hostId);
  const serverSpkiSha256 = requirePin(value.serverSpkiSha256);
  const issuerSpkiSha256 = requirePin(value.issuerSpkiSha256);
  const deviceKeyId = requireUuid(value.deviceKeyId);
  const requestPem = requireRequestPem(value.requestPem);
  const notBefore = value.notBefore;
  const notAfter = value.notAfter;
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter)
    || (notBefore as number) <= 0 || (notAfter as number) <= (notBefore as number)
    || (notBefore as number) % 1000 !== 0 || (notAfter as number) % 1000 !== 0
    || (notBefore as number) > MAX_DATE_MS || (notAfter as number) > MAX_DATE_MS
    || (notAfter as number) - (notBefore as number) > MAX_SIGNING_LIFETIME_MS) {
    throw invalidInput();
  }
  return { hostId, serverSpkiSha256, issuerSpkiSha256, deviceKeyId, requestPem,
    notBefore: notBefore as number, notAfter: notAfter as number };
}

function validateInspectResult(value: unknown): InspectResult {
  const result = ownRecord(value, ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "issuerCertificate"],
    ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "issuerCertificate"]);
  return Object.freeze({
    hostId: requireUuid(result.hostId),
    serverSpkiSha256: requirePin(result.serverSpkiSha256),
    issuerSpkiSha256: requirePin(result.issuerSpkiSha256),
    issuerCertificate: requireCertificate(result.issuerCertificate),
  });
}

function validateSignResult(value: unknown, requestPem: string): SignResult {
  const result = ownRecord(value, ["certificate", "requestSha256"], ["certificate", "requestSha256"]);
  const certificate = requireCertificate(result.certificate);
  const requestSha256 = requirePin(result.requestSha256);
  const expected = createHash("sha256").update(requestPem).digest("hex");
  if (requestSha256 !== expected) throw invalidInput();
  return Object.freeze({ certificate, requestSha256 });
}

function requireChannel(value: unknown): IpcChannel {
  try {
    const channel = value as IpcChannel;
    if (!channel || typeof channel !== "object" || typeof channel.connected !== "boolean"
      || typeof channel.send !== "function" || typeof channel.on !== "function"
      || typeof channel.removeListener !== "function") throw unavailable();
    return channel;
  } catch {
    throw unavailable();
  }
}

/**
 * Parent-process IPC transports signer requests only. The channel does not
 * establish a user or SPS session; ingress must authenticate those separately.
 */
export function createSpsNativeParentSignerClient(
  channelValue: unknown = process,
  optionsValue: SpsNativeParentSignerClientOptions = {},
): SpsNativeParentSignerClient {
  const channel = requireChannel(channelValue);
  const options = ownRecord(optionsValue, ["timeoutMs", "maxPending"], []);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1 || (timeoutMs as number) > 30_000
    || !Number.isSafeInteger(maxPending) || (maxPending as number) < 1 || (maxPending as number) > 2) {
    throw invalidInput();
  }

  const pending = new Map<string, PendingRequest>();
  let disposed = false;
  let disconnected = false;

  function clearRequest(id: string, entry: PendingRequest): boolean {
    if (pending.get(id) !== entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortListener) {
      removeAbortListener(entry.signal, entry.abortListener);
    }
    return true;
  }

  function sendCancel(id: string): void {
    if (disconnected || !channel.connected) return;
    try {
      channel.send({ v: 1, kind: REQUEST_KIND, id, operation: "cancel" }, () => {});
    } catch {
      // Cancellation is best effort; the original request is already settled.
    }
  }

  function rejectRequest(id: string, entry: PendingRequest, error: Error, cancel: boolean): void {
    if (!clearRequest(id, entry)) return;
    if (cancel) sendCancel(id);
    entry.reject(error);
  }

  function onMessage(message: unknown): void {
    const id = correlationId(message);
    if (!id) return;
    const entry = pending.get(id);
    if (!entry) return;
    try {
      const response = ownRecord(message, ["v", "kind", "id", "ok", "result", "errorCode"], ["v", "kind", "id", "ok"]);
      if (response.v !== 1 || response.kind !== RESPONSE_KIND || response.id !== id || typeof response.ok !== "boolean") {
        throw invalidInput();
      }
      const keys = Reflect.ownKeys(response);
      if (response.ok) {
        if (keys.length !== 5 || !Object.hasOwn(response, "result") || Object.hasOwn(response, "errorCode")) throw invalidInput();
        const result = entry.operation === "inspect"
          ? validateInspectResult(response.result)
          : validateSignResult(response.result, (entry as PendingRequest & { requestPem: string }).requestPem);
        if (clearRequest(id, entry)) entry.resolve(result);
        return;
      }
      if (keys.length !== 5 || !Object.hasOwn(response, "errorCode") || Object.hasOwn(response, "result")
        || response.errorCode !== "native_signer_unavailable") throw invalidInput();
      if (clearRequest(id, entry)) entry.reject(unavailable());
    } catch {
      rejectRequest(id, entry, unavailable(), true);
    }
  }

  function onDisconnect(): void {
    disconnected = true;
    for (const [id, entry] of pending) rejectRequest(id, entry, unavailable(), false);
  }

  function onExit(): void {
    onDisconnect();
  }

  function isAvailable(): boolean {
    try {
      return !disposed && !disconnected && channel.connected === true;
    } catch {
      return false;
    }
  }

  function assertAvailable(): void {
    if (!isAvailable()) throw unavailable();
  }

  try {
    channel.on("message", onMessage);
    channel.on("disconnect", onDisconnect);
    channel.on("exit", onExit);
  } catch {
    try { channel.removeListener("message", onMessage); } catch { /* no-op */ }
    try { channel.removeListener("disconnect", onDisconnect); } catch { /* no-op */ }
    try { channel.removeListener("exit", onExit); } catch { /* no-op */ }
    throw unavailable();
  }

  function request<T extends InspectResult | SignResult>(
    operation: Operation,
    payload: SignPayload | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (!isAvailable()) return Promise.reject(unavailable());
    if (signal && isAborted(signal)) return Promise.reject(clientError("native_signer_aborted"));
    if (pending.size >= (maxPending as number)) return Promise.reject(clientError("native_signer_busy"));

    let id = randomUUID();
    while (pending.has(id)) id = randomUUID();
    const message = payload
      ? { v: 1, kind: REQUEST_KIND, id, operation, payload }
      : { v: 1, kind: REQUEST_KIND, id, operation };

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest & { requestPem?: string } = {
        operation,
        resolve: value => resolve(value as T),
        reject,
        signal,
        timer: setTimeout(() => rejectRequest(id, entry, clientError("native_signer_timeout"), true), timeoutMs as number),
        ...(payload ? { requestPem: payload.requestPem } : {}),
      };
      pending.set(id, entry);
      if (signal) {
        entry.abortListener = () => rejectRequest(id, entry, clientError("native_signer_aborted"), true);
        try {
          addAbortListener(signal, entry.abortListener);
        } catch {
          rejectRequest(id, entry, invalidInput(), false);
          return;
        }
        if (isAborted(signal)) {
          rejectRequest(id, entry, clientError("native_signer_aborted"), false);
          return;
        }
      }
      if (!pending.has(id)) return;
      try {
        const send = channel.send as (request: unknown, callback: (error: Error | null) => void) => unknown;
        send.call(channel, message, error => {
          if (error) rejectRequest(id, entry, unavailable(), false);
        });
      } catch {
        rejectRequest(id, entry, unavailable(), false);
      }
    });
  }

  return Object.freeze({
    async inspect(optionsValue: { signal?: AbortSignal } = {}): Promise<InspectResult> {
      const options = ownRecord(optionsValue, ["signal"], []);
      return await request<InspectResult>("inspect", undefined, signalValue(options.signal));
    },
    async sign(inputValue: SpsNativeParentSignerRequest): Promise<SignResult> {
      const input = ownRecord(inputValue, ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "deviceKeyId", "requestPem", "notBefore", "notAfter", "signal"],
        ["hostId", "serverSpkiSha256", "issuerSpkiSha256", "deviceKeyId", "requestPem", "notBefore", "notAfter"]);
      const payload = validateSignPayload(input);
      return await request<SignResult>("sign", payload, signalValue(input.signal));
    },
    isAvailable,
    assertAvailable,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [id, entry] of pending) rejectRequest(id, entry, unavailable(), true);
      try { channel.removeListener("message", onMessage); } catch { /* no-op */ }
      try { channel.removeListener("disconnect", onDisconnect); } catch { /* no-op */ }
      try { channel.removeListener("exit", onExit); } catch { /* no-op */ }
    },
  });
}
