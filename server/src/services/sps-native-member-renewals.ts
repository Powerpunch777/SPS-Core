import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { TLSSocket } from "node:tls";
import { and, eq, sql } from "drizzle-orm";
import { spsMemberDeviceRenewalCertificates, spsMemberDevices, type Db } from "../compat/paperclip/db.js";
import {
  getSpsNativeEnrollmentPeerCertificate,
  type SpsNativeEnrollmentAuthorizer,
  type SpsNativeMainIngressPeer,
} from "./sps-native-enrollments.js";

type RenewalRow = typeof spsMemberDeviceRenewalCertificates.$inferSelect;
type RenewInput = { userId: string; deviceKeyId: string; requestPem: string };
type SigningRequest = {
  hostId: string;
  deviceKeyId: string;
  requestPem: string;
  notBefore: number;
  notAfter: number;
  expectedSpkiSha256: string;
  signal: AbortSignal;
};
export type SpsNativeMemberRenewalSigner = (input: SigningRequest) => Promise<{
  certificate: string;
  requestSha256: string;
}>;

type Options = {
  hostId: string;
  serverSpkiSha256: string;
  issuerCertificate: string;
  certificateLifetimeMs: number;
  signingTimeoutMs: number;
  maxConcurrentSignings: number;
};

export type SpsNativeMemberRenewalPeer = TLSSocket | SpsNativeMainIngressPeer;
export type SpsNativeMemberRenewalDto = Readonly<{
  renewalId: string;
  deviceId: string;
  predecessorCertificateSha256: string;
  certificate: string;
  issuerCertificate: string;
  certificateNotBefore: string;
  certificateNotAfter: string;
}>;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";
const MAX_LIFETIME = 90 * 86_400_000;
const DEFAULT_RENEWAL_WINDOW = 30 * 86_400_000;
const MAX_CERTIFICATE_BYTES = 4096;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export class SpsNativeMemberRenewalError extends Error {
  readonly code = "native_enrollment_unavailable";
  readonly status = 409;
  constructor() {
    super("This SPS Member certificate renewal is unavailable. Existing credentials were not replaced.");
    this.name = "SpsNativeMemberRenewalError";
  }
}

function deny(): never { throw new SpsNativeMemberRenewalError(); }

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) deny();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some(key => typeof key !== "string" || !keys.includes(key))) deny();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) deny();
    result[key] = descriptor.value;
  }
  return result;
}

function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
  return value;
}

function requireUserId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) deny();
  return value;
}

function parseRequest(value: unknown): string {
  if (typeof value !== "string" || value.length > 3000) deny();
  const body = value.replace(/^-----BEGIN CERTIFICATE REQUEST-----\n/, "")
    .replace(/\n-----END CERTIFICATE REQUEST-----\n$/, "");
  if (!/^[A-Za-z0-9+/=\n]+$/.test(body)) deny();
  const bytes = Buffer.from(body.replaceAll("\n", ""), "base64");
  if (bytes.length < 1 || bytes.length > 2048) deny();
  const canonical = "-----BEGIN CERTIFICATE REQUEST-----\n"
    + bytes.toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END CERTIFICATE REQUEST-----\n";
  if (canonical !== value) deny();
  return value;
}

function parseCertificate(value: unknown): X509Certificate {
  if (typeof value !== "string" || value.length < 1 || value.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(value)) deny();
  const der = Buffer.from(value, "base64url");
  if (der.length < 1 || der.length > MAX_CERTIFICATE_BYTES || der.toString("base64url") !== value) deny();
  let parsed: X509Certificate;
  try { parsed = new X509Certificate(der); } catch { deny(); }
  if (!parsed.raw.equals(der)) deny();
  return parsed;
}

function certSha256(certificate: X509Certificate): string {
  return digest(certificate.raw);
}

function spkiSha256(certificate: X509Certificate): string {
  return digest(certificate.publicKey.export({ type: "spki", format: "der" }));
}

function memberDeviceKeyId(certificate: X509Certificate, hostId: string): string {
  const match = new RegExp(`^CN=SPS Member Device (${UUID.source.slice(1, -1)})\\nOU=SPS Native Host ${hostId.replaceAll("-", "\\-")}$`).exec(certificate.subject);
  if (!match?.[1] || !UUID.test(match[1])) deny();
  return match[1];
}

function checkLeaf(input: {
  certificate: X509Certificate;
  hostId: string;
  deviceKeyId: string;
  issuer: X509Certificate;
  notBefore?: number;
  notAfter?: number;
  expectedSpkiSha256: string;
}) {
  const { certificate, hostId, deviceKeyId, issuer, notBefore, notAfter, expectedSpkiSha256 } = input;
  const before = Date.parse(certificate.validFrom), after = Date.parse(certificate.validTo);
  if (certificate.ca || !certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey)
    || certificate.subject !== `CN=SPS Member Device ${deviceKeyId}\nOU=SPS Native Host ${hostId}`
    || certificate.publicKey.asymmetricKeyType !== "ec"
    || certificate.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    || certificate.keyUsage?.length !== 1 || certificate.keyUsage[0] !== CLIENT_AUTH
    || !Number.isFinite(before) || before > Date.now() || !Number.isFinite(after) || after <= Date.now()
    || before < Date.parse(issuer.validFrom) || after > Date.parse(issuer.validTo) || after - before > MAX_LIFETIME
    || (notBefore !== undefined && before !== notBefore) || (notAfter !== undefined && after !== notAfter)
    || spkiSha256(certificate) !== expectedSpkiSha256) deny();
  return { before, after, certificateSha256: certSha256(certificate) };
}

function rowDto(row: RenewalRow, issuerCertificate: string): SpsNativeMemberRenewalDto {
  return Object.freeze({
    renewalId: row.id,
    deviceId: row.deviceId,
    predecessorCertificateSha256: row.predecessorCertificateSha256,
    certificate: row.certificate,
    issuerCertificate,
    certificateNotBefore: row.certificateNotBefore.toISOString(),
    certificateNotAfter: row.certificateNotAfter.toISOString(),
  });
}

/** Performs one same-key renewal from an exact registered live TLS peer. */
export function createSpsNativeMemberRenewalService(
  db: Db,
  options: Options,
  sign: SpsNativeMemberRenewalSigner,
  assertActive: () => void = () => {},
) {
  const hostId = requireUuid(options.hostId);
  if (!SHA256.test(options.serverSpkiSha256) || typeof sign !== "function" || typeof assertActive !== "function"
    || !Number.isSafeInteger(options.certificateLifetimeMs) || options.certificateLifetimeMs < 1000
    || options.certificateLifetimeMs > MAX_LIFETIME || options.certificateLifetimeMs % 1000 !== 0
    || !Number.isSafeInteger(options.signingTimeoutMs) || options.signingTimeoutMs < 1000 || options.signingTimeoutMs > 30000
    || !Number.isSafeInteger(options.maxConcurrentSignings) || options.maxConcurrentSignings < 1
    || options.maxConcurrentSignings > 4) deny();

  const lifetime = options.certificateLifetimeMs;
  const signingTimeout = options.signingTimeoutMs;
  const maxConcurrentSignings = options.maxConcurrentSignings;
  const renewalWindowMs = Math.min(DEFAULT_RENEWAL_WINDOW, Math.floor(lifetime / 3));
  const issuer = parseCertificate(options.issuerCertificate);
  const issuerCertificate = issuer.raw.toString("base64url");
  const issuerSpkiSha256 = spkiSha256(issuer);
  if (!issuer.ca || issuer.subject !== `CN=SPS Member Issuer ${hostId}` || issuer.subject !== issuer.issuer
    || !issuer.verify(issuer.publicKey) || issuer.publicKey.asymmetricKeyType !== "ec"
    || issuer.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") deny();

  let activeSignings = 0;

  function assertCurrentIssuer() {
    const notBefore = Date.parse(issuer.validFrom), notAfter = Date.parse(issuer.validTo);
    if (!Number.isFinite(notBefore) || notBefore > Date.now() || !Number.isFinite(notAfter) || notAfter <= Date.now()) deny();
    return { notBefore, notAfter };
  }

  function currentPeerCertificate(peer: SpsNativeMemberRenewalPeer, expectedSha256?: string): X509Certificate {
    assertActive();
    const certificate = getSpsNativeEnrollmentPeerCertificate(peer);
    const before = Date.parse(certificate.validFrom), after = Date.parse(certificate.validTo);
    if (!Number.isFinite(before) || before > Date.now() || !Number.isFinite(after) || after <= Date.now()
      || certSha256(certificate) !== expectedSha256 && expectedSha256 !== undefined) deny();
    assertActive();
    return certificate;
  }

  async function authorize(authorizeInTransaction: SpsNativeEnrollmentAuthorizer, tx: Parameters<Parameters<Db["transaction"]>[0]>[0], userId: string) {
    await authorizeInTransaction(tx, userId);
    assertActive();
  }

  async function resolveParent(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], userId: string, peerCertificate: X509Certificate, deviceKeyId: string) {
    const [device] = await tx.select().from(spsMemberDevices).where(and(
      eq(spsMemberDevices.hostId, hostId),
      eq(spsMemberDevices.ownerUserId, userId),
      eq(spsMemberDevices.spkiSha256, spkiSha256(peerCertificate)),
    )).for("update");
    if (!device || device.status !== "approved" || device.revision < 1
      || device.spkiSha256 !== spkiSha256(peerCertificate)
      || memberDeviceKeyId(peerCertificate, hostId) !== deviceKeyId) deny();

    const predecessorCertificateSha256 = certSha256(peerCertificate);
    let predecessorCertificate: X509Certificate;
    let predecessorNotBefore: Date;
    let predecessorNotAfter: Date;

    if (device.certificateSha256 === predecessorCertificateSha256) {
      predecessorCertificate = parseCertificate(device.certificate);
      predecessorNotBefore = device.certificateNotBefore;
      predecessorNotAfter = device.certificateNotAfter;
      if (device.spkiSha256 !== spkiSha256(predecessorCertificate)
        || memberDeviceKeyId(predecessorCertificate, hostId) !== deviceKeyId) deny();
    } else {
      const [renewal] = await tx.select().from(spsMemberDeviceRenewalCertificates).where(and(
        eq(spsMemberDeviceRenewalCertificates.deviceId, device.id),
        eq(spsMemberDeviceRenewalCertificates.certificateSha256, predecessorCertificateSha256),
      )).for("share").limit(1);
      if (!renewal || renewal.spkiSha256 !== device.spkiSha256 || renewal.deviceKeyId !== deviceKeyId
        || renewal.issuerSpkiSha256 !== issuerSpkiSha256 || renewal.actorUserId !== userId) deny();
      predecessorCertificate = parseCertificate(renewal.certificate);
      predecessorNotBefore = renewal.certificateNotBefore;
      predecessorNotAfter = renewal.certificateNotAfter;
    }

    const checkedPredecessor = checkLeaf({
      certificate: predecessorCertificate,
      hostId,
      deviceKeyId,
      issuer,
      expectedSpkiSha256: device.spkiSha256,
    });
    if (checkedPredecessor.certificateSha256 !== predecessorCertificateSha256
      || checkedPredecessor.before !== predecessorNotBefore.getTime()
      || checkedPredecessor.after !== predecessorNotAfter.getTime()
      || !peerCertificate.raw.equals(predecessorCertificate.raw)
      || predecessorNotAfter.getTime() <= Date.now()) deny();
    return { device, predecessorCertificateSha256, predecessorCertificate, predecessorNotBefore, predecessorNotAfter };
  }

  async function safeRenew(peer: SpsNativeMemberRenewalPeer, input: RenewInput, authorizeInTransaction: SpsNativeEnrollmentAuthorizer): Promise<SpsNativeMemberRenewalDto> {
    try {
      if (typeof authorizeInTransaction !== "function") deny();
      assertActive();
      const raw = exactRecord(input, ["userId", "deviceKeyId", "requestPem"]);
      const userId = requireUserId(raw.userId);
      const deviceKeyId = requireUuid(raw.deviceKeyId);
      const requestPem = parseRequest(raw.requestPem);
      const requestSha256 = digest(requestPem);
      const peerCertificate = currentPeerCertificate(peer);
      if (memberDeviceKeyId(peerCertificate, hostId) !== deviceKeyId) deny();
      const initialPeerSha256 = certSha256(peerCertificate);
      const issuerDates = assertCurrentIssuer();

      const result = await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await authorize(authorizeInTransaction, tx, userId);
        const parent = await resolveParent(tx, userId, peerCertificate, deviceKeyId);

        const replayQuery = tx.select().from(spsMemberDeviceRenewalCertificates).where(and(
          eq(spsMemberDeviceRenewalCertificates.deviceId, parent.device.id),
          eq(spsMemberDeviceRenewalCertificates.predecessorCertificateSha256, parent.predecessorCertificateSha256),
        )).for("share").limit(1);
        const [existing] = await replayQuery;
        if (existing) {
          if (existing.requestSha256 !== requestSha256 || existing.actorUserId !== userId
            || existing.deviceKeyId !== deviceKeyId || existing.spkiSha256 !== parent.device.spkiSha256
            || existing.issuerSpkiSha256 !== issuerSpkiSha256) deny();
          const storedCertificate = parseCertificate(existing.certificate);
          const checkedStored = checkLeaf({ certificate: storedCertificate, hostId, deviceKeyId, issuer,
            expectedSpkiSha256: parent.device.spkiSha256 });
          if (checkedStored.certificateSha256 !== existing.certificateSha256
            || checkedStored.before !== existing.certificateNotBefore.getTime()
            || checkedStored.after !== existing.certificateNotAfter.getTime()
            || existing.predecessorCertificateSha256 !== parent.predecessorCertificateSha256
            || existing.certificateNotAfter.getTime() <= parent.predecessorNotAfter.getTime()) deny();
          await authorize(authorizeInTransaction, tx, userId);
          if (certSha256(currentPeerCertificate(peer, initialPeerSha256)) !== parent.predecessorCertificateSha256) deny();
          return rowDto(existing, issuerCertificate);
        }

        const now = Date.now();
        const predecessorNotAfter = parent.predecessorNotAfter.getTime();
        const window = Math.min(renewalWindowMs, Math.floor((predecessorNotAfter - parent.predecessorNotBefore.getTime()) / 3));
        if (predecessorNotAfter <= now || predecessorNotAfter - now > window) deny();
        if (activeSignings >= maxConcurrentSignings) deny();
        const notBefore = Math.floor(now / 1000) * 1000;
        const notAfter = Math.min(notBefore + lifetime, issuerDates.notAfter);
        if (notAfter <= predecessorNotAfter || notAfter <= now || notBefore < issuerDates.notBefore) deny();

        activeSignings++;
        let released = false;
        let signingSettled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        const release = () => {
          if (released) return;
          released = true;
          activeSignings--;
        };
        const signing = Promise.resolve().then(() => sign(Object.freeze({
          hostId,
          deviceKeyId,
          requestPem,
          notBefore,
          notAfter,
          expectedSpkiSha256: parent.device.spkiSha256,
          signal: controller.signal,
        }))).finally(() => {
          signingSettled = true;
          release();
        });
        try {
          const signed = await Promise.race([
            signing,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new SpsNativeMemberRenewalError());
              }, signingTimeout);
            }),
          ]);
          const signedRecord = exactRecord(signed, ["certificate", "requestSha256"]);
          if (signedRecord.requestSha256 !== requestSha256) deny();
          const renewedCertificate = parseCertificate(signedRecord.certificate);
          const checkedRenewed = checkLeaf({ certificate: renewedCertificate, hostId, deviceKeyId, issuer,
            notBefore, notAfter, expectedSpkiSha256: parent.device.spkiSha256 });
          if (checkedRenewed.certificateSha256 === parent.predecessorCertificateSha256
            || checkedRenewed.after <= predecessorNotAfter) deny();

          await authorize(authorizeInTransaction, tx, userId);
          assertCurrentIssuer();
          if (certSha256(currentPeerCertificate(peer, initialPeerSha256)) !== parent.predecessorCertificateSha256) deny();
          const [currentParent] = await tx.select({
            id: spsMemberDevices.id,
            status: spsMemberDevices.status,
            revision: spsMemberDevices.revision,
            spkiSha256: spsMemberDevices.spkiSha256,
            ownerUserId: spsMemberDevices.ownerUserId,
          }).from(spsMemberDevices).where(and(
            eq(spsMemberDevices.id, parent.device.id),
            eq(spsMemberDevices.hostId, hostId),
            eq(spsMemberDevices.ownerUserId, userId),
          )).for("update").limit(1);
          if (!currentParent || currentParent.status !== "approved" || currentParent.revision !== parent.device.revision
            || currentParent.spkiSha256 !== parent.device.spkiSha256 || currentParent.ownerUserId !== userId
            || parent.predecessorNotAfter.getTime() <= Date.now() || checkedRenewed.after <= Date.now()) deny();
          const [stored] = await tx.insert(spsMemberDeviceRenewalCertificates).values({
            deviceId: parent.device.id,
            predecessorCertificateSha256: parent.predecessorCertificateSha256,
            certificate: renewedCertificate.raw.toString("base64url"),
            certificateSha256: checkedRenewed.certificateSha256,
            spkiSha256: parent.device.spkiSha256,
            issuerSpkiSha256,
            requestSha256,
            deviceKeyId,
            certificateNotBefore: new Date(checkedRenewed.before),
            certificateNotAfter: new Date(checkedRenewed.after),
            actorUserId: userId,
          }).returning();
          if (!stored) deny();
          await authorize(authorizeInTransaction, tx, userId);
          assertCurrentIssuer();
          if (certSha256(currentPeerCertificate(peer, initialPeerSha256)) !== parent.predecessorCertificateSha256
            || parent.predecessorNotAfter.getTime() <= Date.now() || checkedRenewed.after <= Date.now()) deny();
          return rowDto(stored, issuerCertificate);
        } finally {
          clearTimeout(timer);
          if (!signingSettled) {
            // A timeout or caller cancellation does not release capacity until
            // the signer has actually stopped, preventing unbounded late work.
            void signing.then(release, release);
          }
        }
      });
      assertActive();
      assertCurrentIssuer();
      currentPeerCertificate(peer, initialPeerSha256);
      return result;
    } catch {
      throw new SpsNativeMemberRenewalError();
    }
  }

  return Object.freeze({
    renewFromTlsPeer(
      peer: SpsNativeMemberRenewalPeer,
      input: RenewInput,
      authorizeInTransaction: SpsNativeEnrollmentAuthorizer,
    ) {
      return safeRenew(peer, input, authorizeInTransaction);
    },
  });
}
