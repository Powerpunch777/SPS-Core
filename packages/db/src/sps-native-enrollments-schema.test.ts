import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  spsNativeEnrollments,
  spsNativePairingEvents,
  spsNativePairings,
} from "./index.js";
import { sanitizePostRestoreDatabase } from "./post-restore-sanitizer.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

describe("Native enrollment schema and generated migration", () => {
  it("exports only bounded public issuance state with a unique cascading pairing reference", () => {
    const config = getTableConfig(spsNativeEnrollments);
    expect(config.columns.map((column) => column.name)).toEqual([
      "id", "pairing_id", "host_id", "server_spki_sha256", "issuer_spki_sha256",
      "user_id", "device_key_id", "request_sha256", "status", "certificate",
      "certificate_sha256", "created_at", "expires_at", "issued_at", "failed_at",
    ]);
    expect(spsNativeEnrollments.id.primary).toBe(true);
    for (const column of [spsNativeEnrollments.id, spsNativeEnrollments.pairingId,
      spsNativeEnrollments.hostId, spsNativeEnrollments.deviceKeyId]) {
      expect(column.getSQLType()).toBe("uuid");
      expect(column.notNull).toBe(true);
    }
    expect(config.indexes).toHaveLength(1);
    expect(config.indexes[0].config.unique).toBe(true);
    expect(config.indexes[0].config.columns.map((column) => (column as { name: string }).name))
      .toEqual(["pairing_id"]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0].onDelete).toBe("cascade");
    expect(config.foreignKeys[0].reference().foreignTable).toBe(spsNativePairings);
    expect(config.foreignKeys[0].reference().foreignColumns).toEqual([spsNativePairings.id]);
  });

  it("keeps generated SQL checks synchronized and adds no changes to existing tables", async () => {
    const migration = await readFile(new URL("./migrations/0167_absurd_loki.sql", import.meta.url), "utf8");
    const dialect = new PgDialect();
    for (const constraint of getTableConfig(spsNativeEnrollments).checks) {
      const expression = dialect.sqlToQuery(constraint.value).sql;
      expect(migration).toContain(`CONSTRAINT "${constraint.name}" CHECK (${expression})`);
    }
    const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim());
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^CREATE TABLE "sps_native_enrollments" /);
    expect(statements[1]).toMatch(/^ALTER TABLE "sps_native_enrollments" ADD CONSTRAINT /);
    expect(statements[2]).toMatch(/^CREATE UNIQUE INDEX /);
    const previous = JSON.parse(await readFile(new URL("./migrations/meta/0166_snapshot.json", import.meta.url), "utf8"));
    const current = JSON.parse(await readFile(new URL("./migrations/meta/0167_snapshot.json", import.meta.url), "utf8"));
    expect(current.prevId).toBe(previous.id);
    const { "public.sps_native_enrollments": enrollment, ...existingTables } = current.tables;
    expect(enrollment).toBeDefined();
    expect(existingTables).toEqual(previous.tables);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping Native enrollment PostgreSQL checks: ${support.reason ?? "unsupported environment"}`);

describePostgres("Native enrollment PostgreSQL constraints and restore", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const createdAt = new Date("2026-10-25T00:00:00.000Z");
  const expiresAt = new Date("2026-10-25T01:00:00.000Z");
  const certificate = Buffer.from([0x30, 0x00]).toString("base64url");
  const certificateSha256 = createHash("sha256").update(Buffer.from(certificate, "base64url")).digest("hex");

  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("sps-native-enrollment-schema-");
    db = createDb(fixture.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end();
    await fixture?.cleanup();
  });

  async function signingRow(): Promise<typeof spsNativeEnrollments.$inferInsert> {
    const hostId = randomUUID();
    const [pairing] = await db.insert(spsNativePairings).values({
      hostId, serverSpkiSha256: "a".repeat(64), issuedByUserId: "fixture-owner",
      secretSha256: "b".repeat(64), maxAttempts: 5, createdAt, expiresAt,
    }).returning();
    return {
      pairingId: pairing.id, hostId, serverSpkiSha256: "a".repeat(64),
      issuerSpkiSha256: "c".repeat(64), userId: "fixture-member", deviceKeyId: randomUUID(),
      requestSha256: "d".repeat(64), createdAt, expiresAt,
    };
  }

  it("allows signing defaults and enforces one row per existing pairing with cascading deletion", async () => {
    const row = await signingRow();
    const [stored] = await db.insert(spsNativeEnrollments).values(row).returning();
    expect(stored).toMatchObject({ status: "signing", certificate: null, certificateSha256: null, issuedAt: null, failedAt: null });
    await expect(db.insert(spsNativeEnrollments).values(row)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(db.insert(spsNativeEnrollments).values({ ...row, pairingId: randomUUID() }))
      .rejects.toMatchObject({ cause: { code: "23503" } });
    await db.delete(spsNativePairings).where(eq(spsNativePairings.id, row.pairingId));
    expect(await db.select().from(spsNativeEnrollments).where(eq(spsNativeEnrollments.id, stored.id))).toEqual([]);
  });

  it("rejects invalid fingerprints, user bounds, expiry, certificate encoding and certificate bounds", async () => {
    const row = { ...await signingRow(), status: "issued", certificate, certificateSha256, issuedAt: createdAt };
    const invalid: Array<Partial<typeof spsNativeEnrollments.$inferInsert>> = [
      { serverSpkiSha256: "a".repeat(63) }, { issuerSpkiSha256: "G".repeat(64) },
      { requestSha256: "A".repeat(64) }, { certificateSha256: "a".repeat(65) },
      { userId: "" }, { userId: "u".repeat(201) }, { expiresAt: createdAt },
      { status: "pending" }, { certificate: "" }, { certificate: "A" },
      { certificate: "MAA=" }, { certificate: "MA+" }, { certificate: "MAB" },
      { certificate: "A".repeat(5464) },
    ];
    for (const patch of invalid) {
      await expect(db.insert(spsNativeEnrollments).values({ ...row, ...patch }))
        .rejects.toMatchObject({ cause: { code: "23514" } });
    }
    await db.insert(spsNativeEnrollments).values({ ...row, userId: "u".repeat(200), certificate: "A".repeat(5462) });
  });

  it("requires issued material and an issuance time inside the half-open enrollment window", async () => {
    const row = { ...await signingRow(), status: "issued", certificate, certificateSha256, issuedAt: createdAt };
    for (const patch of [{ certificate: null }, { certificateSha256: null }, { issuedAt: null },
      { issuedAt: new Date(createdAt.getTime() - 1) }, { issuedAt: expiresAt }]) {
      await expect(db.insert(spsNativeEnrollments).values({ ...row, ...patch }))
        .rejects.toMatchObject({ cause: { code: "23514" } });
    }
    await db.insert(spsNativeEnrollments).values(row);
  });

  it("requires a failed timestamp and forbids issued material in signing and failed states", async () => {
    const row = await signingRow();
    await expect(db.insert(spsNativeEnrollments).values({ ...row, status: "failed" }))
      .rejects.toMatchObject({ cause: { code: "23514" } });
    for (const status of ["signing", "failed"]) {
      for (const material of [{ certificate }, { certificateSha256 }, { issuedAt: createdAt }]) {
        await expect(db.insert(spsNativeEnrollments).values({ ...row, status, failedAt: createdAt, ...material }))
          .rejects.toMatchObject({ cause: { code: "23514" } });
      }
    }
    await db.insert(spsNativeEnrollments).values({ ...row, status: "failed", failedAt: createdAt });
  });

  it("scrubs enrollment trust and pairings on restore while retaining pairing audit snapshots", async () => {
    const row = await signingRow();
    await db.insert(spsNativeEnrollments).values({ ...row, status: "issued", certificate, certificateSha256, issuedAt: createdAt });
    const [event] = await db.insert(spsNativePairingEvents).values({
      hostId: row.hostId, pairingId: row.pairingId, pairingSnapshotId: row.pairingId,
      actorUserId: row.userId, action: "created",
    }).returning();
    const result = await sanitizePostRestoreDatabase(fixture!.connectionString);
    expect(result.scrubbedTables.sps_native_enrollments).toBeGreaterThan(0);
    expect(await db.select().from(spsNativeEnrollments)).toEqual([]);
    expect(await db.select().from(spsNativePairings)).toEqual([]);
    expect(await db.select().from(spsNativePairingEvents).where(eq(spsNativePairingEvents.id, event.id)))
      .toEqual([{ ...event, pairingId: null }]);
  });
});
