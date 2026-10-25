import { createHash, X509Certificate } from "node:crypto";
import { TLSSocket } from "node:tls";
import { and, eq } from "drizzle-orm";
import { spsNativeEnrollments, spsNativePairings, spsNativePairingEvents, type Db } from "../compat/paperclip/db.js";
import { spsNativePairingService, type SpsNativePairingPolicy } from "./sps-native-pairings.js";
import { registerPendingSpsMemberDeviceInTransaction } from "./sps-member-devices.js";

type EnrollmentRow = typeof spsNativeEnrollments.$inferSelect;
type Admission = { pairingId: string; pairingSecret: string; userId: string };
type IssueInput = Admission & { deviceKeyId: string; requestPem: string };
type CompleteInput = Admission & { enrollmentId: string; displayName: string };
type SigningRequest = { hostId: string; deviceKeyId: string; requestPem: string; notBefore: number; notAfter: number; signal: AbortSignal };
// A trusted Main-owned implementation must validate PKCS#10 signature/profile and
// bind the resulting leaf to this exact request. No CA key crosses this port.
export type SpsNativeEnrollmentSigner = (input: SigningRequest) => Promise<{ certificate: string; requestSha256: string }>;
type Options = {
  hostId: string; serverSpkiSha256: string; issuerCertificate: string;
  pairingPolicy: SpsNativePairingPolicy; certificateLifetimeMs: number;
  signingTimeoutMs: number; maxConcurrentSignings: number;
};
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const MAX_LIFETIME = 90 * 86_400_000;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export class SpsNativeEnrollmentError extends Error {
  readonly code = "native_enrollment_unavailable";
  readonly status = 409;
  constructor() { super("This SPS device enrollment is unavailable. Existing credentials were not replaced."); }
}
function deny(): never { throw new SpsNativeEnrollmentError(); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !keys.includes(key))) deny();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) deny();
    copy[key] = descriptor.value;
  }
  return copy;
}
function uuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) deny(); return value; }
function admission(value: Record<string, unknown>): Admission {
  const pairingId = uuid(value.pairingId);
  if (typeof value.userId !== "string" || !value.userId.trim() || value.userId.length > 200
    || /[\u0000-\u001f\u007f]/.test(value.userId) || typeof value.pairingSecret !== "string") deny();
  return { pairingId, pairingSecret: value.pairingSecret, userId: value.userId };
}
function certificate(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(value)) deny();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > 4096 || bytes.toString("base64url") !== value) deny();
  const parsed = new X509Certificate(bytes);
  if (!parsed.raw.equals(bytes)) deny();
  return parsed;
}
function request(value: unknown) {
  if (typeof value !== "string" || value.length > 3000) deny();
  const body = value.replace(/^-----BEGIN CERTIFICATE REQUEST-----\n/, "").replace(/\n-----END CERTIFICATE REQUEST-----\n$/, "");
  if (!/^[A-Za-z0-9+/=\n]+$/.test(body)) deny();
  const bytes = Buffer.from(body.replaceAll("\n", ""), "base64");
  if (bytes.length < 1 || bytes.length > 2048) deny();
  const canonical = "-----BEGIN CERTIFICATE REQUEST-----\n"
    + bytes.toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END CERTIFICATE REQUEST-----\n";
  if (canonical !== value) deny();
  return value;
}

/** Inactive Host-private orchestration. A verified DB user is NOT a session.
 * The future ingress must authenticate the real SPS session before either call.
 * There is no HTTP/IPC/SDK call site or listener in this increment. */
export function spsNativeEnrollmentService(db: Db, options: Options, sign: SpsNativeEnrollmentSigner) {
  const hostId = uuid(options.hostId);
  if (!SHA.test(options.serverSpkiSha256) || typeof sign !== "function"
    || !Number.isSafeInteger(options.certificateLifetimeMs) || options.certificateLifetimeMs < 1000
    || options.certificateLifetimeMs > MAX_LIFETIME || options.certificateLifetimeMs % 1000 !== 0
    || !Number.isSafeInteger(options.signingTimeoutMs) || options.signingTimeoutMs < 1000 || options.signingTimeoutMs > 30000
    || !Number.isSafeInteger(options.maxConcurrentSignings) || options.maxConcurrentSignings < 1 || options.maxConcurrentSignings > 4) deny();
  const serverPin = options.serverSpkiSha256;
  const lifetime = options.certificateLifetimeMs, timeout = options.signingTimeoutMs, concurrency = options.maxConcurrentSignings;
  const issuer = certificate(options.issuerCertificate);
  const issuerCertificate = issuer.raw.toString("base64url");
  const issuerPin = digest(issuer.publicKey.export({ type: "spki", format: "der" }));
  if (!issuer.ca || issuer.subject !== `CN=SPS Member Issuer ${hostId}` || issuer.subject !== issuer.issuer
    || !issuer.verify(issuer.publicKey) || issuer.publicKey.asymmetricKeyType !== "ec"
    || issuer.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") deny();
  const pairing = spsNativePairingService(db, hostId, options.pairingPolicy, { serverSpkiSha256: serverPin });
  let active = 0;

  function currentIssuer() {
    if (!Number.isFinite(Date.parse(issuer.validFrom)) || !Number.isFinite(Date.parse(issuer.validTo))
      || Date.parse(issuer.validFrom) > Date.now() || Date.parse(issuer.validTo) <= Date.now()) deny();
  }
  function leaf(value: unknown, deviceKeyId: string) {
    currentIssuer();
    const parsed = certificate(value);
    const before = Date.parse(parsed.validFrom), after = Date.parse(parsed.validTo);
    if (parsed.ca || !parsed.checkIssued(issuer) || !parsed.verify(issuer.publicKey)
      || parsed.subject !== `CN=SPS Member Device ${deviceKeyId}\nOU=SPS Native Host ${hostId}`
      || parsed.publicKey.asymmetricKeyType !== "ec" || parsed.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      || parsed.keyUsage?.length !== 1 || parsed.keyUsage[0] !== CLIENT_AUTH
      || !Number.isFinite(before) || !Number.isFinite(after) || before > Date.now() || after <= Date.now()
      || before < Date.parse(issuer.validFrom) || after > Date.parse(issuer.validTo) || after - before > MAX_LIFETIME) deny();
    return { parsed, before, after, sha256: digest(parsed.raw) };
  }
  function projection(row: EnrollmentRow) {
    if (row.status !== "issued" || !row.certificate || !row.certificateSha256 || row.expiresAt.getTime() <= Date.now()) deny();
    if (leaf(row.certificate, row.deviceKeyId).sha256 !== row.certificateSha256) deny();
    return Object.freeze({ enrollmentId: row.id, certificate: row.certificate, issuerCertificate, expiresAt: row.expiresAt.toISOString() });
  }
  function reservedBinding(row: EnrollmentRow) {
    return and(
      eq(spsNativeEnrollments.id, row.id), eq(spsNativeEnrollments.pairingId, row.pairingId),
      eq(spsNativeEnrollments.hostId, hostId), eq(spsNativeEnrollments.serverSpkiSha256, serverPin),
      eq(spsNativeEnrollments.issuerSpkiSha256, issuerPin), eq(spsNativeEnrollments.userId, row.userId),
      eq(spsNativeEnrollments.deviceKeyId, row.deviceKeyId), eq(spsNativeEnrollments.requestSha256, row.requestSha256),
      eq(spsNativeEnrollments.createdAt, row.createdAt), eq(spsNativeEnrollments.expiresAt, row.expiresAt),
      eq(spsNativeEnrollments.status, "signing"),
    );
  }
  async function safe<T>(operation: () => Promise<T>) {
    try { return await operation(); } catch { throw new SpsNativeEnrollmentError(); }
  }
  function peer(socket: TLSSocket) {
    if (!(socket instanceof TLSSocket) || socket.destroyed || !socket.encrypted || !socket.authorized
      || socket.getProtocol() !== "TLSv1.3" || socket.isSessionReused()) deny();
    const value = socket.getPeerX509Certificate();
    if (!value) deny();
    return digest(value.raw);
  }

  return {
    issue(input: IssueInput) {
      return safe(async () => {
        const raw = record(input, ["pairingId", "pairingSecret", "userId", "deviceKeyId", "requestPem"]);
        const scope = admission(raw), deviceKeyId = uuid(raw.deviceKeyId), requestPem = request(raw.requestPem);
        const requestSha256 = digest(requestPem);
        currentIssuer();
        if (active >= concurrency) deny();
        active++;
        let deferredRelease = false;
        try {
          const reserved = await pairing.withEnrollmentInvitation(scope, async (tx, invitation) => {
            const [existing] = await tx.select().from(spsNativeEnrollments).where(eq(spsNativeEnrollments.pairingId, invitation.id));
            if (existing) {
              if (existing.hostId !== hostId || existing.serverSpkiSha256 !== serverPin || existing.issuerSpkiSha256 !== issuerPin
                || existing.userId !== scope.userId || existing.deviceKeyId !== deviceKeyId || existing.requestSha256 !== requestSha256
                || existing.expiresAt.getTime() !== invitation.expiresAt.getTime()
                || existing.createdAt < invitation.createdAt || existing.createdAt.getTime() > Date.now()) deny();
              return { row: existing, created: false };
            }
            const [row] = await tx.insert(spsNativeEnrollments).values({
              pairingId: invitation.id, hostId, serverSpkiSha256: serverPin, issuerSpkiSha256: issuerPin,
              userId: scope.userId, deviceKeyId, requestSha256, status: "signing", createdAt: new Date(), expiresAt: invitation.expiresAt,
            }).returning();
            if (!row) deny();
            return { row, created: true };
          });
          if (!reserved.created) return projection(reserved.row);
          const controller = new AbortController();
          let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
          const notBefore = Math.floor(Date.now() / 1000) * 1000;
          const notAfter = Math.min(notBefore + lifetime, Date.parse(issuer.validTo));
          const signing = Promise.resolve().then(() => sign(Object.freeze({ hostId, deviceKeyId, requestPem, notBefore, notAfter, signal: controller.signal })))
            .finally(() => { settled = true; });
          try {
            const result = await Promise.race([signing, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new SpsNativeEnrollmentError()); }, timeout);
            })]);
            const signed = record(result, ["certificate", "requestSha256"]);
            if (signed.requestSha256 !== requestSha256) deny();
            const checked = leaf(signed.certificate, deviceKeyId);
            if (checked.before !== notBefore || checked.after !== notAfter) deny();
            return await pairing.withEnrollmentInvitation(scope, async (tx) => {
              const [row] = await tx.update(spsNativeEnrollments).set({
                status: "issued", certificate: checked.parsed.raw.toString("base64url"), certificateSha256: checked.sha256, issuedAt: new Date(),
              }).where(reservedBinding(reserved.row)).returning();
              if (!row) deny();
              return projection(row);
            });
          } catch {
            // No automatic re-sign after an ambiguous failure/restart. A fresh
            // invitation is required; an uncommitted certificate cannot enroll.
            await db.update(spsNativeEnrollments).set({ status: "failed", failedAt: new Date() })
              .where(reservedBinding(reserved.row));
            deny();
          } finally {
            clearTimeout(timer);
            if (!settled) {
              deferredRelease = true;
              void signing.then(() => { active--; }, () => { active--; });
            }
          }
        } finally { if (!deferredRelease) active--; }
      });
    },
    completeFromTlsPeer(socket: TLSSocket, input: CompleteInput) {
      return safe(async () => {
        const raw = record(input, ["pairingId", "pairingSecret", "userId", "enrollmentId", "displayName"]);
        const scope = admission(raw), enrollmentId = uuid(raw.enrollmentId);
        if (typeof raw.displayName !== "string") deny();
        const displayName = raw.displayName;
        const fingerprint = peer(socket);
        currentIssuer();
        return pairing.withEnrollmentInvitation(scope, async (tx, invitation) => {
          const [row] = await tx.select().from(spsNativeEnrollments).where(and(
            eq(spsNativeEnrollments.id, enrollmentId), eq(spsNativeEnrollments.pairingId, invitation.id),
          ));
          if (!row || row.status !== "issued" || row.hostId !== hostId || row.serverSpkiSha256 !== serverPin
            || row.issuerSpkiSha256 !== issuerPin || row.userId !== scope.userId
            || row.certificateSha256 !== fingerprint || row.expiresAt.getTime() !== invitation.expiresAt.getTime()
            || row.createdAt < invitation.createdAt || row.createdAt.getTime() > Date.now()
            || row.expiresAt.getTime() <= Date.now()) deny();
          projection(row);
          if (peer(socket) !== fingerprint) deny();
          const device = await registerPendingSpsMemberDeviceInTransaction(tx, hostId, {
            userId: scope.userId, displayName, certificate: row.certificate!,
          });
          if (device.status !== "pending" || device.certificateSha256 !== fingerprint || peer(socket) !== fingerprint) deny();
          await tx.update(spsNativePairings).set({
            status: "consumed", consumedAt: new Date(), consumedByUserId: scope.userId,
            consumedDeviceId: device.id, consumedDeviceSnapshotId: device.id,
          }).where(eq(spsNativePairings.id, invitation.id));
          await tx.insert(spsNativePairingEvents).values({
            hostId, pairingId: invitation.id, pairingSnapshotId: invitation.id, actorUserId: scope.userId,
            action: "consumed", deviceSnapshotId: device.id, createdAt: new Date(),
          });
          projection(row);
          if (peer(socket) !== fingerprint) deny();
          return device;
        });
      });
    },
  };
}
