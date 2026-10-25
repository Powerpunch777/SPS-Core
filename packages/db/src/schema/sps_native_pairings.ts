import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { spsMemberDevices } from "./sps_member_devices.js";

/** Host-internal one-use pairing state; only a digest of the issued secret is stored. */
export const spsNativePairings = pgTable(
  "sps_native_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id").notNull(),
    serverSpkiSha256: text("server_spki_sha256").notNull(),
    issuedByUserId: text("issued_by_user_id").notNull(),
    secretSha256: text("secret_sha256").notNull(),
    targetEmailSha256: text("target_email_sha256"),
    status: text("status").notNull().default("pending"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByUserId: text("consumed_by_user_id"),
    consumedDeviceId: uuid("consumed_device_id").references(() => spsMemberDevices.id, {
      onDelete: "set null",
    }),
    consumedDeviceSnapshotId: uuid("consumed_device_snapshot_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
  },
  (table) => ({
    hostStatusExpiresIdx: index("sps_native_pairings_host_status_expires_idx").on(
      table.hostId,
      table.status,
      table.expiresAt,
    ),
    hostServerSpkiStatusExpiresIdx: index(
      "sps_native_pairings_host_server_spki_status_expires_idx",
    ).on(table.hostId, table.serverSpkiSha256, table.status, table.expiresAt),
    statusCheck: check(
      "sps_native_pairings_status_check",
      sql`${table.status} IN ('pending', 'consumed', 'revoked', 'exhausted')`,
    ),
    secretSha256Check: check(
      "sps_native_pairings_secret_sha256_check",
      sql`length(${table.secretSha256}) = 64 AND ${table.secretSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    targetEmailSha256Check: check(
      "sps_native_pairings_target_email_sha256_check",
      sql`${table.targetEmailSha256} IS NULL OR (length(${table.targetEmailSha256}) = 64 AND ${table.targetEmailSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    serverSpkiSha256Check: check(
      "sps_native_pairings_server_spki_sha256_check",
      sql`length(${table.serverSpkiSha256}) = 64 AND ${table.serverSpkiSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    attemptsCheck: check(
      "sps_native_pairings_attempts_check",
      sql`${table.maxAttempts} > 0 AND ${table.maxAttempts} <= 20 AND ${table.failedAttempts} >= 0 AND ${table.failedAttempts} <= ${table.maxAttempts}`,
    ),
    expiryCheck: check(
      "sps_native_pairings_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    consumedCheck: check(
      "sps_native_pairings_consumed_check",
      sql`${table.status} <> 'consumed' OR (${table.consumedAt} IS NOT NULL AND ${table.consumedByUserId} IS NOT NULL AND ${table.consumedDeviceSnapshotId} IS NOT NULL)`,
    ),
    consumedAtWindowCheck: check(
      "sps_native_pairings_consumed_at_window_check",
      sql`${table.consumedAt} IS NULL OR (${table.consumedAt} >= ${table.createdAt} AND ${table.consumedAt} < ${table.expiresAt})`,
    ),
    revokedCheck: check(
      "sps_native_pairings_revoked_check",
      sql`${table.status} <> 'revoked' OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`,
    ),
  }),
);

/** Redacted pairing history retained independently of pairing and device rows. */
export const spsNativePairingEvents = pgTable(
  "sps_native_pairing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id").notNull(),
    pairingId: uuid("pairing_id").references(() => spsNativePairings.id, { onDelete: "set null" }),
    pairingSnapshotId: uuid("pairing_snapshot_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    deviceSnapshotId: uuid("device_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostPairingSnapshotCreatedIdx: index(
      "sps_native_pairing_events_host_pairing_snapshot_created_idx",
    ).on(table.hostId, table.pairingSnapshotId, table.createdAt),
    actionCheck: check(
      "sps_native_pairing_events_action_check",
      sql`${table.action} IN ('created', 'secret_rejected', 'consumed', 'revoked', 'exhausted')`,
    ),
  }),
);
