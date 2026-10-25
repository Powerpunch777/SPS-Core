import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { spsNativePairings } from "./sps_native_pairings.js";

/** Host-internal issuance state; stores public certificate material, never keys or a full CSR. */
export const spsNativeEnrollments = pgTable(
  "sps_native_enrollments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pairingId: uuid("pairing_id").notNull().references(() => spsNativePairings.id, {
      onDelete: "cascade",
    }),
    hostId: uuid("host_id").notNull(),
    serverSpkiSha256: text("server_spki_sha256").notNull(),
    issuerSpkiSha256: text("issuer_spki_sha256").notNull(),
    userId: text("user_id").notNull(),
    deviceKeyId: uuid("device_key_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    status: text("status").notNull().default("signing"),
    certificate: text("certificate"),
    certificateSha256: text("certificate_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (table) => ({
    pairingUniqueIdx: uniqueIndex("sps_native_enrollments_pairing_id_unique_idx").on(table.pairingId),
    statusCheck: check(
      "sps_native_enrollments_status_check",
      sql`${table.status} IN ('signing', 'issued', 'failed')`,
    ),
    serverSpkiSha256Check: check(
      "sps_native_enrollments_server_spki_sha256_check",
      sql`length(${table.serverSpkiSha256}) = 64 AND ${table.serverSpkiSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    issuerSpkiSha256Check: check(
      "sps_native_enrollments_issuer_spki_sha256_check",
      sql`length(${table.issuerSpkiSha256}) = 64 AND ${table.issuerSpkiSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    userIdCheck: check(
      "sps_native_enrollments_user_id_check",
      sql`length(${table.userId}) BETWEEN 1 AND 200`,
    ),
    requestSha256Check: check(
      "sps_native_enrollments_request_sha256_check",
      sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    certificateCheck: check(
      "sps_native_enrollments_certificate_check",
      sql`${table.certificate} IS NULL OR (length(${table.certificate}) BETWEEN 2 AND 5462 AND ${table.certificate} ~ '^([A-Za-z0-9_-]{4})*([A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$')`,
    ),
    certificateSha256Check: check(
      "sps_native_enrollments_certificate_sha256_check",
      sql`${table.certificateSha256} IS NULL OR (length(${table.certificateSha256}) = 64 AND ${table.certificateSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    expiryCheck: check(
      "sps_native_enrollments_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    issuedCheck: check(
      "sps_native_enrollments_issued_check",
      sql`${table.status} <> 'issued' OR (${table.certificate} IS NOT NULL AND ${table.certificateSha256} IS NOT NULL AND ${table.issuedAt} IS NOT NULL AND ${table.issuedAt} >= ${table.createdAt} AND ${table.issuedAt} < ${table.expiresAt})`,
    ),
    unissuedCheck: check(
      "sps_native_enrollments_unissued_check",
      sql`${table.status} = 'issued' OR (${table.certificate} IS NULL AND ${table.certificateSha256} IS NULL AND ${table.issuedAt} IS NULL)`,
    ),
    failedCheck: check(
      "sps_native_enrollments_failed_check",
      sql`${table.status} <> 'failed' OR ${table.failedAt} IS NOT NULL`,
    ),
  }),
);
