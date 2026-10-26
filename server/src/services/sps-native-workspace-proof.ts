import { createHash, createHmac, timingSafeEqual, X509Certificate } from "node:crypto";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE = /^sps_identity_session=[A-Za-z0-9_-]{64}$/;
const METHODS = new Set(["GET", "PUT", "PATCH"]);
const CONTENT_TYPES = new Set(["", "application/json"]);
const MAX_HEADER_LENGTH = 8192;
const MAX_CERTIFICATE_BYTES = 4096;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TARGET_BYTES = 2048;
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const MAX_REPLAY_ENTRIES = 4096;
const CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2";
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
const DISCOVERY_TARGET = "/sps-native/v1/workspaces";

export type SpsNativeWorkspaceProofActualRequest = Readonly<{
  method: string;
  target: string;
  body: Buffer;
  cookie: string;
  contentType: string;
}>;

export type SpsNativeWorkspaceProof = Readonly<{
  v: 1;
  hostId: string;
  workspaceId: string | null;
  method: "GET" | "PUT" | "PATCH";
  target: string;
  nonce: string;
  issuedAt: number;
  bodySha256: string;
  cookie: string;
  contentType: "" | "application/json";
  peerCertificateDer: Buffer;
}>;

type ProofArray = readonly [1, string, string | null, string, string, string, number, string, string, string, string];
type VerifierOptions = {
  hostId: string;
  key: Buffer;
  assertCurrent: () => void;
  now?: () => number;
  maxReplay?: number;
};

function unavailable(): Error { return new Error("Native Workspace request proof is unavailable."); }

function exactRecord(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.some(key => typeof key !== "string" || !allowed.includes(key))
      || required.some(key => !Object.hasOwn(descriptors, key))) throw unavailable();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of actual as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
      result[key] = descriptor.value;
    }
    return result;
  } catch { throw unavailable(); }
}

function canonicalUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

function canonicalTarget(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES
    || !value.startsWith("/") || value.startsWith("//") || /[^\x21-\x7e]|[\\#]/.test(value)
    || /%(?![0-9a-fA-F]{2})|%(?:2f|5c)/i.test(value)) return false;
  try {
    const parsed = new URL(value, "http://sps-native.invalid");
    if (parsed.origin !== "http://sps-native.invalid" || parsed.hash || `${parsed.pathname}${parsed.search}` !== value) return false;
    for (const segment of parsed.pathname.split("/")) {
      let decoded: string;
      try { decoded = decodeURIComponent(segment); } catch { return false; }
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false;
    }
    return true;
  } catch { return false; }
}

function decodeCanonicalBase64Url(value: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64url") !== value) throw unavailable();
  return bytes;
}

function proofArray(value: unknown): ProofArray {
  if (!Array.isArray(value) || value.length !== 11 || value.some(item => item !== null && typeof item === "object")) {
    throw unavailable();
  }
  const fields = value as unknown[];
  if (fields[0] !== 1 || !canonicalUuid(fields[1])
    || !(fields[2] === null ? fields[3] === "GET" && fields[4] === DISCOVERY_TARGET : canonicalUuid(fields[2]))
    || (fields[4] === DISCOVERY_TARGET && fields[2] !== null)
    || typeof fields[3] !== "string" || !METHODS.has(fields[3])
    || !canonicalTarget(fields[4]) || typeof fields[5] !== "string" || !NONCE.test(fields[5])
    || Buffer.from(fields[5], "base64url").length !== 32 || Buffer.from(fields[5], "base64url").toString("base64url") !== fields[5]
    || typeof fields[6] !== "number" || !Number.isSafeInteger(fields[6])
    || typeof fields[7] !== "string" || !SHA256.test(fields[7])
    || typeof fields[8] !== "string" || !COOKIE.test(fields[8])
    || typeof fields[9] !== "string" || !CONTENT_TYPES.has(fields[9])
    || typeof fields[10] !== "string") throw unavailable();
  return fields as unknown as ProofArray;
}

function assertCurrent(assertion: () => void) {
  let result: unknown;
  try { result = assertion(); } catch { throw unavailable(); }
  if (result !== undefined) {
    if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
    throw unavailable();
  }
}

function validClientCertificate(encoded: string, now: number): Buffer {
  const der = decodeCanonicalBase64Url(encoded, MAX_CERTIFICATE_BYTES);
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(der); } catch { throw unavailable(); }
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!certificate.raw.equals(der) || certificate.ca
    || !certificate.keyUsage?.includes(CLIENT_AUTH_OID) || certificate.keyUsage.includes(SERVER_AUTH_OID)
    || !Number.isFinite(notBefore) || notBefore > now || !Number.isFinite(notAfter) || notAfter <= now) throw unavailable();
  return Buffer.from(der);
}

/**
 * Verifies the private Main-to-Core request proof. It is not an HTTP listener,
 * session/device authorization decision, or substitute for Main's mTLS check.
 */
export function createSpsNativeWorkspaceProofVerifier(optionsValue: VerifierOptions) {
  const options = exactRecord(optionsValue, ["hostId", "key", "assertCurrent", "now", "maxReplay"],
    ["hostId", "key", "assertCurrent"]);
  const hostId = options.hostId;
  const key = options.key;
  const assertCurrentInput = options.assertCurrent;
  const now = options.now === undefined ? Date.now : options.now;
  const maxReplay = options.maxReplay === undefined ? MAX_REPLAY_ENTRIES : options.maxReplay;
  if (!canonicalUuid(hostId) || !Buffer.isBuffer(key) || key.length !== 32
    || typeof assertCurrentInput !== "function" || typeof now !== "function"
    || typeof maxReplay !== "number" || !Number.isSafeInteger(maxReplay)
    || maxReplay < 1 || maxReplay > MAX_REPLAY_ENTRIES) {
    throw new TypeError("Invalid Native Workspace proof verifier configuration.");
  }
  const secret = Buffer.from(key);
  const currentGuard = assertCurrentInput as () => void;
  const replay = new Map<string, number>();
  let disposed = false;

  function checkActive() {
    if (disposed) throw unavailable();
    assertCurrent(currentGuard);
    if (disposed) throw unavailable();
  }

  return Object.freeze({
    verify(header: string, actualValue: unknown): SpsNativeWorkspaceProof {
      checkActive();
      if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_LENGTH) throw unavailable();
      const actual = exactRecord(actualValue, ["method", "target", "body", "cookie", "contentType"]);
      if (typeof actual.method !== "string" || !METHODS.has(actual.method)
        || !canonicalTarget(actual.target) || !Buffer.isBuffer(actual.body) || actual.body.length > MAX_BODY_BYTES
        || typeof actual.cookie !== "string" || !COOKIE.test(actual.cookie)
        || typeof actual.contentType !== "string" || !CONTENT_TYPES.has(actual.contentType)) throw unavailable();

      const separator = header.indexOf(".");
      if (separator < 1 || separator !== header.lastIndexOf(".") || separator === header.length - 1) throw unavailable();
      const payloadText = header.slice(0, separator);
      const macText = header.slice(separator + 1);
      const payloadBytes = decodeCanonicalBase64Url(payloadText, MAX_HEADER_LENGTH);
      const suppliedMac = decodeCanonicalBase64Url(macText, 32);
      if (suppliedMac.length !== 32) throw unavailable();
      let decoded: unknown;
      let canonicalText: string;
      try {
        canonicalText = payloadBytes.toString("utf8");
        decoded = JSON.parse(canonicalText);
      } catch { throw unavailable(); }
      const fields = proofArray(decoded);
      if (JSON.stringify(fields) !== canonicalText || fields[1] !== hostId
        || fields[3] !== actual.method || fields[4] !== actual.target
        || fields[7] !== createHash("sha256").update(actual.body).digest("hex")
        || fields[8] !== actual.cookie || fields[9] !== actual.contentType) throw unavailable();

      const expectedMac = createHmac("sha256", secret).update(payloadBytes).digest();
      if (!timingSafeEqual(expectedMac, suppliedMac)) throw unavailable();
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime)) throw unavailable();
      const issuedAt = fields[6];
      if (issuedAt > currentTime + MAX_FUTURE_MS || currentTime - issuedAt > MAX_AGE_MS) throw unavailable();
      const certificateDer = validClientCertificate(fields[10], currentTime);

      for (const [nonce, expiresAt] of replay) if (expiresAt < currentTime) replay.delete(nonce);
      if (replay.has(fields[5]) || replay.size >= maxReplay) throw unavailable();
      // Keep a nonce until its proof timestamp can no longer pass the age check.
      replay.set(fields[5], issuedAt + MAX_AGE_MS);
      checkActive();

      const context = {
        v: 1 as const,
        hostId,
        workspaceId: fields[2],
        method: fields[3] as "GET" | "PUT" | "PATCH",
        target: fields[4],
        nonce: fields[5],
        issuedAt,
        bodySha256: fields[7],
        cookie: fields[8],
        contentType: fields[9] as "" | "application/json",
        get peerCertificateDer() { return Buffer.from(certificateDer); },
      };
      return Object.freeze(context);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      secret.fill(0);
      replay.clear();
    },
  });
}
