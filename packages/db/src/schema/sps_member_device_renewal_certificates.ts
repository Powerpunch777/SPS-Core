import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { spsMemberDevices } from "./sps_member_devices.js";

/** Append-only certificate lineage for an approved Member device key. */
export const spsMemberDeviceRenewalCertificates = pgTable(
  "sps_member_device_renewal_certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id").notNull().references(() => spsMemberDevices.id, { onDelete: "cascade" }),
    predecessorCertificateSha256: text("predecessor_certificate_sha256").notNull(),
    certificate: text("certificate").notNull(),
    certificateSha256: text("certificate_sha256").notNull(),
    spkiSha256: text("spki_sha256").notNull(),
    issuerSpkiSha256: text("issuer_spki_sha256").notNull(),
    requestSha256: text("request_sha256").notNull(),
    deviceKeyId: uuid("device_key_id").notNull(),
    certificateNotBefore: timestamp("certificate_not_before", { withTimezone: true }).notNull(),
    certificateNotAfter: timestamp("certificate_not_after", { withTimezone: true }).notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    predecessorUniqueIdx: uniqueIndex(
      "sps_member_device_renewal_certificates_device_predecessor_sha256_unique_idx",
    ).on(table.deviceId, table.predecessorCertificateSha256),
    certificateSha256UniqueIdx: uniqueIndex(
      "sps_member_device_renewal_certificates_certificate_sha256_unique_idx",
    ).on(table.certificateSha256),
    deviceCreatedIdx: index(
      "sps_member_device_renewal_certificates_device_created_idx",
    ).on(table.deviceId, table.createdAt),
    predecessorCertificateSha256Check: check(
      "sps_member_device_renewal_certificates_predecessor_sha256_check",
      sql`length(${table.predecessorCertificateSha256}) = 64 AND ${table.predecessorCertificateSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    certificateCheck: check(
      "sps_member_device_renewal_certificates_certificate_check",
      sql`length(${table.certificate}) BETWEEN 2 AND 5462 AND ${table.certificate} ~ '^([A-Za-z0-9_-]{4})*([A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$'`,
    ),
    certificateSha256Check: check(
      "sps_member_device_renewal_certificates_certificate_sha256_check",
      sql`length(${table.certificateSha256}) = 64 AND ${table.certificateSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    spkiSha256Check: check(
      "sps_member_device_renewal_certificates_spki_sha256_check",
      sql`length(${table.spkiSha256}) = 64 AND ${table.spkiSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    issuerSpkiSha256Check: check(
      "sps_member_device_renewal_certificates_issuer_spki_sha256_check",
      sql`length(${table.issuerSpkiSha256}) = 64 AND ${table.issuerSpkiSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    requestSha256Check: check(
      "sps_member_device_renewal_certificates_request_sha256_check",
      sql`length(${table.requestSha256}) = 64 AND ${table.requestSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    actorUserIdCheck: check(
      "sps_member_device_renewal_certificates_actor_user_id_check",
      sql`length(${table.actorUserId}) BETWEEN 1 AND 200`,
    ),
    expiryCheck: check(
      "sps_member_device_renewal_certificates_expiry_check",
      sql`${table.certificateNotAfter} > ${table.certificateNotBefore}`,
    ),
  }),
);
