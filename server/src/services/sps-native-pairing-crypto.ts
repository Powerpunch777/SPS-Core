import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PAIRING_DOMAIN = "sps-native-pairing:v1";
const EMAIL_DOMAIN = "sps-native-pairing-email:v1";
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAIRING_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LOCAL_PART_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function invalidInput(): TypeError {
  return new TypeError("Invalid SPS native pairing input");
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 || !UUID_PATTERN.test(value)) throw invalidInput();
  return value.toLowerCase();
}

function decodePairingSecret(value: unknown): Buffer {
  if (typeof value !== "string" || !PAIRING_SECRET_PATTERN.test(value)) throw invalidInput();

  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw invalidInput();
  return bytes;
}

function pairingDigestInput(hostId: unknown, pairingId: unknown, secret: unknown): Buffer {
  const canonicalHostId = canonicalUuid(hostId);
  const canonicalPairingId = canonicalUuid(pairingId);
  const secretBytes = decodePairingSecret(secret);
  const prefix = Buffer.from(`${PAIRING_DOMAIN}\0${canonicalHostId}\0${canonicalPairingId}\0`, "ascii");
  return Buffer.concat([prefix, secretBytes]);
}

export function createSpsNativePairingSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSpsNativePairingSecret(hostId: string, pairingId: string, secret: string): string {
  return createHash("sha256").update(pairingDigestInput(hostId, pairingId, secret)).digest("hex");
}

export function verifySpsNativePairingSecret(
  hostId: string,
  pairingId: string,
  secret: string,
  storedSha256: string,
): boolean {
  if (typeof storedSha256 !== "string" || storedSha256.length !== 64 || !SHA256_PATTERN.test(storedSha256)) return false;

  try {
    const actual = createHash("sha256").update(pairingDigestInput(hostId, pairingId, secret)).digest();
    const expected = Buffer.from(storedSha256, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function canonicalEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) throw invalidInput();

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x7e || code < 0x20 || code === 0x7f) throw invalidInput();
  }

  const email = value.trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) throw invalidInput();

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART_PATTERN.test(local) || domain.length > 253) throw invalidInput();

  const labels = domain.split(".");
  if (labels.some((label) => label.length === 0 || label.length > 63 || !DOMAIN_LABEL_PATTERN.test(label))) {
    throw invalidInput();
  }

  return email;
}

// This digest avoids storing raw email; callers must check authUsers.emailVerified separately.
// It is neither ownership verification nor anonymization.
export function hashSpsNativePairingEmail(email: string): string {
  const canonical = canonicalEmail(email);
  return createHash("sha256")
    .update(`${EMAIL_DOMAIN}\0`, "ascii")
    .update(canonical, "ascii")
    .digest("hex");
}
