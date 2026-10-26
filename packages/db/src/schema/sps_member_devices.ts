import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A Host-scoped Native Member device identity; the certificate is public DER only. */
export const spsMemberDevices = pgTable(
  "sps_member_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: text("display_name").notNull(),
    certificate: text("certificate").notNull(),
    certificateSha256: text("certificate_sha256").notNull(),
    spkiSha256: text("spki_sha256").notNull(),
    certificateNotBefore: timestamp("certificate_not_before", { withTimezone: true }).notNull(),
    certificateNotAfter: timestamp("certificate_not_after", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostOwnerCertificateUniqueIdx: uniqueIndex(
      "sps_member_devices_host_owner_certificate_sha256_unique_idx",
    ).on(table.hostId, table.ownerUserId, table.certificateSha256),
    hostOwnerSpkiUniqueIdx: uniqueIndex(
      "sps_member_devices_host_owner_spki_sha256_unique_idx",
    ).on(table.hostId, table.ownerUserId, table.spkiSha256),
    hostStatusIdx: index("sps_member_devices_host_status_idx").on(table.hostId, table.status),
    hostOwnerStatusIdx: index("sps_member_devices_host_owner_status_idx").on(
      table.hostId,
      table.ownerUserId,
      table.status,
    ),
    statusCheck: check(
      "sps_member_devices_status_check",
      sql`${table.status} IN ('pending', 'approved', 'revoked')`,
    ),
    revisionCheck: check("sps_member_devices_revision_check", sql`${table.revision} > 0`),
  }),
);

/** Non-authorizing history retained after its device trust row is removed. */
export const spsMemberDeviceEvents = pgTable(
  "sps_member_device_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id").notNull(),
    deviceId: uuid("device_id").references(() => spsMemberDevices.id, { onDelete: "set null" }),
    deviceSnapshotId: uuid("device_snapshot_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostDeviceSnapshotCreatedIdx: index(
      "sps_member_device_events_host_device_snapshot_created_idx",
    ).on(table.hostId, table.deviceSnapshotId, table.createdAt),
    actionCheck: check(
      "sps_member_device_events_action_check",
      sql`${table.action} IN ('request', 'approved', 'revoked')`,
    ),
    revisionCheck: check("sps_member_device_events_revision_check", sql`${table.revision} > 0`),
  }),
);
