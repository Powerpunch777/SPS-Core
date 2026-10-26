import { createHash, X509Certificate } from "node:crypto";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import type {
  SpsMemberDevice as SharedSpsMemberDevice,
  SpsMemberDeviceEvent as SharedSpsMemberDeviceEvent,
  SpsMemberDeviceStatus as SharedSpsMemberDeviceStatus,
} from "../compat/paperclip/shared.js";
import {
  companies,
  companyMemberships,
  spsMemberDeviceEvents,
  spsMemberDevices,
  spsMemberDeviceRenewalCertificates,
} from "../compat/paperclip/db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const CLIENT_AUTH_OID = "1.3.6.1.5.5.7.3.2";
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
const MAX_CERTIFICATE_BYTES = 4096;
const MAX_LIST_SIZE = 200;

export type SpsMemberDeviceAction = "request" | "approved" | "revoked";
export type SpsMemberDeviceDto = SharedSpsMemberDevice;
export type SpsMemberDeviceEventDto = SharedSpsMemberDeviceEvent;

export type SpsMemberDeviceAuthorization = {
  deviceId: string;
  hostId: string;
  userId: string;
  companyId: string;
  revision: number;
  certificateSha256: string;
  certificateNotAfter: Date;
};

export type SpsMemberDeviceAuthorizationInput = {
  companyId: string;
  userId: string;
  certificateSha256: string;
};

export type SpsMemberAuthorizedWorkspace = Readonly<{ id: string; name: string }>;
export type SpsMemberDeviceWorkspaceAuthorization = Readonly<{
  deviceId: string;
  hostId: string;
  userId: string;
  revision: number;
  certificateSha256: string;
  certificateNotAfter: Date;
  workspaces: readonly SpsMemberAuthorizedWorkspace[];
}>;
export type SpsMemberDeviceWorkspaceAuthorizationInput = Readonly<{ userId: string; certificateSha256: string }>;

export type SpsMemberDeviceErrorCode =
  | "invalid_input"
  | "workspace_membership_required"
  | "device_not_found"
  | "device_conflict"
  | "device_revoked"
  | "certificate_invalid"
  | "certificate_not_valid"
  | "revision_exhausted"
  | "not_authorized";

const ERROR_STATUS: Record<SpsMemberDeviceErrorCode, number> = {
  invalid_input: 400,
  workspace_membership_required: 403,
  device_not_found: 404,
  device_conflict: 409,
  device_revoked: 409,
  certificate_invalid: 400,
  certificate_not_valid: 409,
  revision_exhausted: 409,
  not_authorized: 403,
};

export class SpsMemberDeviceError extends Error {
  readonly status: number;

  constructor(readonly code: SpsMemberDeviceErrorCode, message: string) {
    super(message);
    this.name = "SpsMemberDeviceError";
    this.status = ERROR_STATUS[code];
  }
}

type DeviceRow = typeof spsMemberDevices.$inferSelect;
type DeviceProjectionRow = Pick<DeviceRow, keyof SpsMemberDeviceDto>;
type DeviceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SpsMemberDeviceHostAuthority = Readonly<{
  userId: string;
  authorizeInTransaction(tx: DeviceTransaction, expectedUserId: string): Promise<void>;
}>;

const DEVICE_PUBLIC_COLUMNS = {
  id: spsMemberDevices.id,
  hostId: spsMemberDevices.hostId,
  ownerUserId: spsMemberDevices.ownerUserId,
  displayName: spsMemberDevices.displayName,
  certificateSha256: spsMemberDevices.certificateSha256,
  spkiSha256: spsMemberDevices.spkiSha256,
  certificateNotBefore: spsMemberDevices.certificateNotBefore,
  certificateNotAfter: spsMemberDevices.certificateNotAfter,
  status: spsMemberDevices.status,
  revision: spsMemberDevices.revision,
  approvedByUserId: spsMemberDevices.approvedByUserId,
  approvedAt: spsMemberDevices.approvedAt,
  revokedAt: spsMemberDevices.revokedAt,
  createdAt: spsMemberDevices.createdAt,
  updatedAt: spsMemberDevices.updatedAt,
};

const EVENT_PUBLIC_COLUMNS = {
  id: spsMemberDeviceEvents.id,
  hostId: spsMemberDeviceEvents.hostId,
  deviceId: spsMemberDeviceEvents.deviceId,
  deviceSnapshotId: spsMemberDeviceEvents.deviceSnapshotId,
  ownerUserId: spsMemberDeviceEvents.ownerUserId,
  actorUserId: spsMemberDeviceEvents.actorUserId,
  action: spsMemberDeviceEvents.action,
  revision: spsMemberDeviceEvents.revision,
  createdAt: spsMemberDeviceEvents.createdAt,
};

function invalidInput(message: string): never {
  throw new SpsMemberDeviceError("invalid_input", message);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidInput(`Invalid ${label}.`);
  }
  return value.toLowerCase();
}

function requireUserId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalidInput(`Invalid ${label}.`);
  }
  return value;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalidInput("Invalid device display name.");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) invalidInput("Invalid device display name.");
  return normalized;
}

function parseCertificate(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 5462 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }
  const der = Buffer.from(value, "base64url");
  if (der.length < 1 || der.length > MAX_CERTIFICATE_BYTES || der.toString("base64url") !== value) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(der);
  } catch {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }
  if (!certificate.raw.equals(der) || certificate.ca) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }
  const extendedKeyUsages = certificate.keyUsage;
  if (!Array.isArray(extendedKeyUsages)
    || !extendedKeyUsages.includes(CLIENT_AUTH_OID) || extendedKeyUsages.includes(SERVER_AUTH_OID)) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }
  if (certificate.subject === certificate.issuer && !certificate.verify(certificate.publicKey)) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }

  const certificateNotBefore = new Date(certificate.validFrom);
  const certificateNotAfter = new Date(certificate.validTo);
  if (!Number.isFinite(certificateNotBefore.getTime()) || !Number.isFinite(certificateNotAfter.getTime())) {
    throw new SpsMemberDeviceError("certificate_invalid", "The client certificate is invalid.");
  }
  const now = new Date();
  if (certificateNotBefore > now || certificateNotAfter <= now) {
    throw new SpsMemberDeviceError("certificate_not_valid", "The client certificate is not currently valid.");
  }

  const spki = certificate.publicKey.export({ format: "der", type: "spki" });
  return {
    certificate: value,
    certificateSha256: createHash("sha256").update(der).digest("hex"),
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
    certificateNotBefore,
    certificateNotAfter,
  };
}

function projectDevice(row: DeviceProjectionRow): SpsMemberDeviceDto {
  return {
    id: row.id,
    hostId: row.hostId,
    ownerUserId: row.ownerUserId,
    displayName: row.displayName,
    certificateSha256: row.certificateSha256,
    spkiSha256: row.spkiSha256,
    certificateNotBefore: row.certificateNotBefore.toISOString(),
    certificateNotAfter: row.certificateNotAfter.toISOString(),
    status: row.status as SharedSpsMemberDeviceStatus,
    revision: row.revision,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type MemberDeviceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Internal enrollment primitive; its caller must authenticate and authorize pairing first. */
export async function registerPendingSpsMemberDeviceInTransaction(
  tx: MemberDeviceTransaction,
  hostIdInput: string,
  input: { userId: string; displayName: string; certificate: string },
): Promise<SpsMemberDeviceDto> {
  if (typeof tx?.rollback !== "function") throw new TypeError("A Member enrollment transaction is required");
  const hostId = requireUuid(hostIdInput, "Host ID");
  const userId = requireUserId(input?.userId, "user ID");
  const displayName = normalizeDisplayName(input?.displayName);
  const certificate = parseCertificate(input?.certificate);
  const [created] = await tx.insert(spsMemberDevices).values({
    hostId, ownerUserId: userId, displayName, ...certificate,
  }).onConflictDoNothing().returning(DEVICE_PUBLIC_COLUMNS);
  if (created) {
    await tx.insert(spsMemberDeviceEvents).values({
      hostId, deviceId: created.id, deviceSnapshotId: created.id,
      ownerUserId: userId, actorUserId: userId, action: "request", revision: created.revision,
    });
    return projectDevice(created);
  }
  const [sameCertificate] = await tx.select(DEVICE_PUBLIC_COLUMNS).from(spsMemberDevices).where(and(
    eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.ownerUserId, userId),
    eq(spsMemberDevices.certificateSha256, certificate.certificateSha256),
  )).limit(1).for("update");
  if (sameCertificate) return projectDevice(sameCertificate);
  const [sameKey] = await tx.select({ id: spsMemberDevices.id }).from(spsMemberDevices).where(and(
    eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.ownerUserId, userId),
    eq(spsMemberDevices.spkiSha256, certificate.spkiSha256),
  )).limit(1);
  if (sameKey) {
    throw new SpsMemberDeviceError("device_conflict", "A device using this key is already registered. Use a fresh key.");
  }
  throw new SpsMemberDeviceError("device_conflict", "The device registration conflicts with an existing device.");
}

export function spsMemberDeviceService(db: Db, hostIdInput: string) {
  const hostId = requireUuid(hostIdInput, "Host ID");

  async function appendEvent(
    executor: Pick<Db, "insert">,
    input: {
      deviceId: string;
      ownerUserId: string;
      actorUserId: string;
      action: SpsMemberDeviceAction;
      revision: number;
    },
  ) {
    await executor.insert(spsMemberDeviceEvents).values({
      hostId,
      deviceId: input.deviceId,
      deviceSnapshotId: input.deviceId,
      ownerUserId: input.ownerUserId,
      actorUserId: input.actorUserId,
      action: input.action,
      revision: input.revision,
    });
  }

  return {
    async request(input: {
      companyId: string;
      userId: string;
      displayName: string;
      certificate: string;
    }): Promise<SpsMemberDeviceDto> {
      const companyId = requireUuid(input?.companyId, "Workspace ID");
      const userId = requireUserId(input?.userId, "user ID");

      return db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ id: companyMemberships.id })
          .from(companies)
          .innerJoin(companyMemberships, and(
            eq(companyMemberships.companyId, companies.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ))
          .where(and(eq(companies.id, companyId), eq(companies.status, "active")))
          .limit(1);
        if (!membership) {
          throw new SpsMemberDeviceError(
            "workspace_membership_required",
            "An active Workspace membership is required.",
          );
        }

        return registerPendingSpsMemberDeviceInTransaction(tx, hostId, {
          userId, displayName: input.displayName, certificate: input.certificate,
        });
      });
    },

    async listOwn(companyIdInput: string, userIdInput: string): Promise<SpsMemberDeviceDto[]> {
      const companyId = requireUuid(companyIdInput, "Workspace ID");
      const userId = requireUserId(userIdInput, "user ID");
      const [membership] = await db
        .select({ id: companyMemberships.id })
        .from(companies)
        .innerJoin(companyMemberships, and(
          eq(companyMemberships.companyId, companies.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ))
        .where(and(eq(companies.id, companyId), eq(companies.status, "active")))
        .limit(1);
      if (!membership) {
        throw new SpsMemberDeviceError(
          "workspace_membership_required",
          "An active Workspace membership is required.",
        );
      }

      const rows = await db
        .select(DEVICE_PUBLIC_COLUMNS)
        .from(spsMemberDevices)
        .where(and(
          eq(spsMemberDevices.hostId, hostId),
          eq(spsMemberDevices.ownerUserId, userId),
        ))
        .orderBy(desc(spsMemberDevices.createdAt), desc(spsMemberDevices.id))
        .limit(MAX_LIST_SIZE);
      return rows.map(projectDevice);
    },

    async listHost(authority?: SpsMemberDeviceHostAuthority): Promise<SpsMemberDeviceDto[]> {
      const list = async (connection: Db | DeviceTransaction) => {
        const rows = await connection
          .select(DEVICE_PUBLIC_COLUMNS)
          .from(spsMemberDevices)
          .where(eq(spsMemberDevices.hostId, hostId))
          .orderBy(desc(spsMemberDevices.createdAt), desc(spsMemberDevices.id))
          .limit(MAX_LIST_SIZE);
        return rows.map(projectDevice);
      };
      if (!authority) return await list(db);
      return await db.transaction(async tx => {
        await authority.authorizeInTransaction(tx, authority.userId);
        const result = await list(tx);
        await authority.authorizeInTransaction(tx, authority.userId);
        return result;
      });
    },

    async approve(deviceIdInput: string, actorUserIdInput: string, authority?: SpsMemberDeviceHostAuthority): Promise<SpsMemberDeviceDto> {
      const deviceId = requireUuid(deviceIdInput, "device ID");
      const actorUserId = requireUserId(actorUserIdInput, "actor user ID");
      if (authority && authority.userId !== actorUserId) throw new SpsMemberDeviceError("not_authorized", "The current Host session is required.");
      return db.transaction(async (tx) => {
        if (authority) await authority.authorizeInTransaction(tx, actorUserId);
        const [device] = await tx
          .select(DEVICE_PUBLIC_COLUMNS)
          .from(spsMemberDevices)
          .where(and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.id, deviceId)))
          .for("update");
        if (!device) throw new SpsMemberDeviceError("device_not_found", "The device is unavailable.");
        if (device.status === "revoked") {
          throw new SpsMemberDeviceError("device_revoked", "A revoked device cannot be approved.");
        }
        const now = new Date();
        if (device.certificateNotBefore > now || device.certificateNotAfter <= now) {
          throw new SpsMemberDeviceError("certificate_not_valid", "The device certificate is not currently valid.");
        }
        if (device.status === "approved") {
          if (authority) await authority.authorizeInTransaction(tx, actorUserId);
          if (device.certificateNotAfter <= new Date()) throw new SpsMemberDeviceError("certificate_not_valid", "The device certificate is not currently valid.");
          return projectDevice(device);
        }
        if (device.revision >= 2_147_483_647) {
          throw new SpsMemberDeviceError("revision_exhausted", "The device revision cannot be increased.");
        }

        const [approved] = await tx
          .update(spsMemberDevices)
          .set({
            status: "approved",
            revision: device.revision + 1,
            approvedByUserId: actorUserId,
            approvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(spsMemberDevices.hostId, hostId),
            eq(spsMemberDevices.id, deviceId),
            eq(spsMemberDevices.status, "pending"),
          ))
          .returning(DEVICE_PUBLIC_COLUMNS);
        if (!approved) throw new SpsMemberDeviceError("device_conflict", "The device state changed.");
        await appendEvent(tx, {
          deviceId,
          ownerUserId: approved.ownerUserId,
          actorUserId,
          action: "approved",
          revision: approved.revision,
        });
        if (authority) await authority.authorizeInTransaction(tx, actorUserId);
        if (approved.certificateNotAfter <= new Date()) throw new SpsMemberDeviceError("certificate_not_valid", "The device certificate is not currently valid.");
        return projectDevice(approved);
      });
    },

    async revoke(deviceIdInput: string, actorUserIdInput: string, authority?: SpsMemberDeviceHostAuthority): Promise<SpsMemberDeviceDto> {
      const deviceId = requireUuid(deviceIdInput, "device ID");
      const actorUserId = requireUserId(actorUserIdInput, "actor user ID");
      if (authority && authority.userId !== actorUserId) throw new SpsMemberDeviceError("not_authorized", "The current Host session is required.");
      return db.transaction(async (tx) => {
        if (authority) await authority.authorizeInTransaction(tx, actorUserId);
        const [device] = await tx
          .select(DEVICE_PUBLIC_COLUMNS)
          .from(spsMemberDevices)
          .where(and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.id, deviceId)))
          .for("update");
        if (!device) throw new SpsMemberDeviceError("device_not_found", "The device is unavailable.");
        if (device.status === "revoked") {
          if (authority) await authority.authorizeInTransaction(tx, actorUserId);
          return projectDevice(device);
        }
        if (device.revision >= 2_147_483_647) {
          throw new SpsMemberDeviceError("revision_exhausted", "The device revision cannot be increased.");
        }

        const now = new Date();
        const [revoked] = await tx
          .update(spsMemberDevices)
          .set({
            status: "revoked",
            revision: device.revision + 1,
            revokedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(spsMemberDevices.hostId, hostId),
            eq(spsMemberDevices.id, deviceId),
            eq(spsMemberDevices.status, device.status),
          ))
          .returning(DEVICE_PUBLIC_COLUMNS);
        if (!revoked) throw new SpsMemberDeviceError("device_conflict", "The device state changed.");
        await appendEvent(tx, {
          deviceId,
          ownerUserId: revoked.ownerUserId,
          actorUserId,
          action: "revoked",
          revision: revoked.revision,
        });
        if (authority) await authority.authorizeInTransaction(tx, actorUserId);
        return projectDevice(revoked);
      });
    },

    async authorize(input: SpsMemberDeviceAuthorizationInput): Promise<SpsMemberDeviceAuthorization> {
      // Certificate resolution may use a renewal row; keep that identity and
      // the subsequent membership lookup in one stable authorization snapshot.
      return db.transaction(tx => authorizeCurrent(tx, input, true));
    },

    /** Keeps device, Workspace and membership authority stable while a private
     * Native Workspace transaction reads or mutates the existing Core services. */
    async authorizeInTransaction(
      tx: DeviceTransaction,
      input: SpsMemberDeviceAuthorizationInput,
    ): Promise<SpsMemberDeviceAuthorization> {
      if (typeof tx?.rollback !== "function") throw new TypeError("A Member authorization transaction is required");
      return authorizeCurrent(tx, input, true);
    },

    /** Discovers only active workspaces for the authenticated Member and this
     * current Host certificate. Device and membership rows stay locked through
     * the caller's transaction. A valid device with no memberships returns []. */
    async listAuthorizedWorkspacesInTransaction(
      tx: DeviceTransaction,
      input: SpsMemberDeviceWorkspaceAuthorizationInput,
    ): Promise<SpsMemberDeviceWorkspaceAuthorization> {
      if (typeof tx?.rollback !== "function") throw new TypeError("A Member authorization transaction is required");
      const userId = requireUserId(input?.userId, "user ID");
      if (typeof input.certificateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.certificateSha256)) {
        invalidInput("Invalid certificate fingerprint.");
      }
      const now = new Date();
      const device = await resolveApprovedDeviceCertificate(tx, hostId, userId, input.certificateSha256, now, true);
      if (!device) throw new SpsMemberDeviceError("not_authorized", "No active approved device matches this request.");

      const workspaces = await tx.select({ id: companies.id, name: companies.name })
        .from(companies)
        .innerJoin(companyMemberships, and(
          eq(companyMemberships.companyId, companies.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ))
        .where(eq(companies.status, "active"))
        .orderBy(companies.id)
        .limit(MAX_LIST_SIZE + 1)
        .for("share");
      if (workspaces.length > MAX_LIST_SIZE) {
        throw new SpsMemberDeviceError("not_authorized", "Too many active workspaces are available.");
      }
      return Object.freeze({
        ...device,
        workspaces: Object.freeze(workspaces.map(workspace => Object.freeze({ id: workspace.id, name: workspace.name }))),
      });
    },

    async listEvents(deviceIdInput: string, authority?: SpsMemberDeviceHostAuthority): Promise<SpsMemberDeviceEventDto[]> {
      const deviceId = requireUuid(deviceIdInput, "device ID");
      const list = async (connection: Db | DeviceTransaction) => {
        const rows = await connection
          .select(EVENT_PUBLIC_COLUMNS)
          .from(spsMemberDeviceEvents)
          .where(and(
            eq(spsMemberDeviceEvents.hostId, hostId),
            eq(spsMemberDeviceEvents.deviceSnapshotId, deviceId),
          ))
          .orderBy(desc(spsMemberDeviceEvents.createdAt), desc(spsMemberDeviceEvents.id))
          .limit(MAX_LIST_SIZE);
        return rows.map((row) => ({
          ...row,
          action: row.action as SharedSpsMemberDeviceEvent["action"],
          createdAt: row.createdAt.toISOString(),
        }));
      };
      if (!authority) return await list(db);
      return await db.transaction(async (tx) => {
        await authority.authorizeInTransaction(tx, authority.userId);
        const events = await list(tx);
        await authority.authorizeInTransaction(tx, authority.userId);
        return events;
      });
    },
  };

  async function authorizeCurrent(
    connection: Db | DeviceTransaction,
    input: SpsMemberDeviceAuthorizationInput,
    lock: boolean,
  ): Promise<SpsMemberDeviceAuthorization> {
      const companyId = requireUuid(input?.companyId, "Workspace ID");
      const userId = requireUserId(input?.userId, "user ID");
      if (typeof input.certificateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.certificateSha256)) {
        invalidInput("Invalid certificate fingerprint.");
      }
      const now = new Date();
      const device = await resolveApprovedDeviceCertificate(connection, hostId, userId, input.certificateSha256, now, lock);
      if (!device) {
        throw new SpsMemberDeviceError("not_authorized", "No active approved device matches this request.");
      }
      const membershipQuery = connection.select({ companyId: companies.id })
        .from(companies)
        .innerJoin(companyMemberships, and(
          eq(companyMemberships.companyId, companies.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ))
        .where(and(eq(companies.id, companyId), eq(companies.status, "active")))
        .limit(1);
      const [membership] = await (lock ? membershipQuery.for("share") : membershipQuery);
      if (!membership) throw new SpsMemberDeviceError("not_authorized", "No active approved device matches this request.");
      return { ...device, companyId: membership.companyId };
  }
}

/** Resolves only an exact currently valid leaf bound to an approved logical device.
 * The immutable base leaf and append-only renewal leaves share the parent status. */
async function resolveApprovedDeviceCertificate(
  connection: Db | DeviceTransaction,
  hostId: string,
  userId: string,
  certificateSha256: string,
  now: Date,
  lock: boolean,
): Promise<Pick<SpsMemberDeviceAuthorization, "deviceId" | "hostId" | "userId" | "revision" | "certificateSha256" | "certificateNotAfter"> | null> {
  const baseQuery = connection.select({
    deviceId: spsMemberDevices.id,
    hostId: spsMemberDevices.hostId,
    userId: spsMemberDevices.ownerUserId,
    revision: spsMemberDevices.revision,
    certificateSha256: spsMemberDevices.certificateSha256,
    certificateNotAfter: spsMemberDevices.certificateNotAfter,
  }).from(spsMemberDevices).where(and(
    eq(spsMemberDevices.hostId, hostId),
    eq(spsMemberDevices.ownerUserId, userId),
    eq(spsMemberDevices.certificateSha256, certificateSha256),
    eq(spsMemberDevices.status, "approved"),
    lte(spsMemberDevices.certificateNotBefore, now),
    gt(spsMemberDevices.certificateNotAfter, now),
  )).limit(1);
  const [base] = await (lock ? baseQuery.for("share") : baseQuery);
  if (base) return base;

  const renewalQuery = connection.select({
    deviceId: spsMemberDevices.id,
    hostId: spsMemberDevices.hostId,
    userId: spsMemberDevices.ownerUserId,
    revision: spsMemberDevices.revision,
    certificateSha256: spsMemberDeviceRenewalCertificates.certificateSha256,
    certificateNotAfter: spsMemberDeviceRenewalCertificates.certificateNotAfter,
  }).from(spsMemberDeviceRenewalCertificates).innerJoin(
    spsMemberDevices,
    eq(spsMemberDevices.id, spsMemberDeviceRenewalCertificates.deviceId),
  ).where(and(
    eq(spsMemberDevices.hostId, hostId),
    eq(spsMemberDevices.ownerUserId, userId),
    eq(spsMemberDevices.status, "approved"),
    eq(spsMemberDeviceRenewalCertificates.certificateSha256, certificateSha256),
    eq(spsMemberDeviceRenewalCertificates.spkiSha256, spsMemberDevices.spkiSha256),
    lte(spsMemberDeviceRenewalCertificates.certificateNotBefore, now),
    gt(spsMemberDeviceRenewalCertificates.certificateNotAfter, now),
  )).limit(1);
  const [renewal] = await (lock ? renewalQuery.for("share") : renewalQuery);
  return renewal ?? null;
}
