import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { spsPluginPackageOperations, type Db } from "../compat/paperclip/db.js";
import { createSpsPluginPackageOperations, type SpsPluginUpgradeOutcome } from "../services/sps-plugin-package-operations.js";

type Row = typeof spsPluginPackageOperations.$inferSelect;
const pluginId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const pluginKey = "sps.retained-review-fixture";
const message = "Plugin retained artifact review records are invalid or unavailable; artifacts were preserved.";
const operationId = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`;

function row(outcome: SpsPluginUpgradeOutcome = "review_required", index = 1): Row {
  const snapshot = (version: string, packagePath: string) => ({
    id: pluginId, pluginKey, packageName: "@sps/retained-review-fixture", packagePath, version, status: "ready",
    lastError: null, installedAt: "2026-11-01T00:00:00.000Z", customMetadata: { preserved: true },
    manifestJson: { id: pluginKey, apiVersion: 1, version, displayName: "Inert retained review fixture",
      description: "Data only; never imported.", author: "SPS", categories: ["automation"],
      capabilities: ["companies.read"], entrypoints: { worker: "./dist/worker.js" } },
  });
  return {
    id: operationId(index), pluginId, pluginKey, kind: "upgrade", activePluginId: null, removeData: false,
    createdAt: new Date("2026-11-01T00:00:00.000Z"), updatedAt: new Date("2026-11-01T00:01:00.000Z"),
    completedAt: new Date("2026-11-01T00:01:00.000Z"),
    snapshotJson: { previous: snapshot("1.0.0", "C:\\synthetic-only\\old\\package"),
      candidate: snapshot("2.0.0", "C:\\synthetic-only\\candidate\\package"), phase: outcome,
      databaseMayChange: true, approvedMigrationPlanHash: "approved-plan", backupFile: "C:\\synthetic-only\\backup.sql.gz" },
  };
}

function rawDatabase(rows: unknown) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn((_condition: SQL | undefined) => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const writes = { insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() };
  const service = createSpsPluginPackageOperations({ select, ...writes } as unknown as Db);
  return { read: () => service.listRetainedArtifactReviews!(), select, from, where, orderBy, limit, writes };
}

const previous = (value: Row) => value.snapshotJson.previous as Record<string, unknown>;
const candidate = (value: Row) => value.snapshotJson.candidate as Record<string, unknown>;
const manifest = (value: Record<string, unknown>) => value.manifestJson as Record<string, unknown>;

describe("Host-private completed package artifact reviews", () => {
  it("uses one bounded completed-upgrade query, without JSON outcome filtering or writes", async () => {
    const db = rawDatabase([]);
    await expect(db.read()).resolves.toEqual([]);
    expect(db.select).toHaveBeenCalledExactlyOnceWith();
    expect(db.from).toHaveBeenCalledExactlyOnceWith(spsPluginPackageOperations);
    const query = new PgDialect().sqlToQuery(db.where.mock.calls[0]![0]!);
    expect(query.sql).toContain('"kind" = $1');
    expect(query.sql).toContain('"completed_at" is not null');
    expect(query.sql).not.toContain("snapshot_json");
    expect(query.params).toEqual(["upgrade"]);
    expect(db.orderBy).toHaveBeenCalledExactlyOnceWith(spsPluginPackageOperations.createdAt, spsPluginPackageOperations.id);
    expect(db.limit).toHaveBeenCalledExactlyOnceWith(60_001);
    for (const write of Object.values(db.writes)) expect(write).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "rolled_back", "review_required"] as const)("validates known outcome %s and retains only required reviews", async outcome => {
    const record = row(outcome);
    const before = structuredClone(record);
    const result = await rawDatabase([record]).read();
    expect(record).toEqual(before);
    expect(result).toEqual(outcome === "review_required" ? [{
      id: record.id, pluginId, pluginKey, snapshot: record.snapshotJson.previous, candidate: record.snapshotJson.candidate,
      backupFile: record.snapshotJson.backupFile, outcome: "review_required",
    }] : []);
  });

  it("preserves both old/candidate records and backup paths, including missing/empty legacy path data", async () => {
    const first = row();
    const second = row("review_required", 2);
    previous(second).packagePath = null;
    candidate(second).packagePath = "";
    second.snapshotJson.backupFile = null;
    const result = await rawDatabase([first, row("succeeded", 3), row("rolled_back", 4), second]).read();
    expect(result).toHaveLength(2);
    expect(result[0]!.snapshot).toEqual(first.snapshotJson.previous);
    expect(result[0]!.candidate).toEqual(first.snapshotJson.candidate);
    expect(result[0]!.backupFile).toBe("C:\\synthetic-only\\backup.sql.gz");
    expect(result[1]!.snapshot.packagePath).toBeNull();
    expect(result[1]!.candidate.packagePath).toBe("");
    expect(result[1]!.backupFile).toBeNull();
    expect((result[0]!.snapshot as unknown as Record<string, unknown>).customMetadata).toEqual({ preserved: true });
  });

  const corruptions: Array<[string, (value: Row) => void]> = [
    ["unknown outcome", value => { value.snapshotJson.phase = "unknown"; }],
    ["pending phase", value => { value.snapshotJson.phase = "activation_entered"; }],
    ["missing phase", value => { delete value.snapshotJson.phase; }],
    ["unknown payload key", value => { value.snapshotJson.hiddenPath = "unaccounted"; }],
    ["missing snapshot", value => { delete value.snapshotJson.previous; }],
    ["missing candidate", value => { delete value.snapshotJson.candidate; }],
    ["invalid snapshot manifest", value => { manifest(previous(value)).entrypoints = {}; }],
    ["invalid candidate manifest", value => { manifest(candidate(value)).entrypoints = {}; }],
    ["snapshot ID mismatch", value => { previous(value).id = otherId; }],
    ["candidate ID mismatch", value => { candidate(value).id = otherId; }],
    ["snapshot key mismatch", value => { previous(value).pluginKey = "sps.other"; }],
    ["candidate key mismatch", value => { candidate(value).pluginKey = "sps.other"; }],
    ["snapshot manifest ID mismatch", value => { manifest(previous(value)).id = "sps.other"; }],
    ["candidate manifest ID mismatch", value => { manifest(candidate(value)).id = "sps.other"; }],
    ["invalid row ID", value => { value.id = "invalid"; }],
    ["invalid row plugin ID", value => { value.pluginId = "invalid"; }],
    ["row key mismatch", value => { value.pluginKey = "sps.other"; }],
    ["wrong row kind", value => { value.kind = "uninstall"; }],
    ["active completed row", value => { value.activePluginId = pluginId; }],
    ["missing completion", value => { value.completedAt = null; }],
    ["invalid completion Date", value => { value.completedAt = new Date(Number.NaN); }],
    ["completion string instead of Date", value => { value.completedAt = "2026-11-01T00:00:00Z" as unknown as Date; }],
    ["removeData set", value => { value.removeData = true; }],
    ["invalid migration flag", value => { value.snapshotJson.databaseMayChange = "yes"; }],
    ["invalid migration hash", value => { value.snapshotJson.approvedMigrationPlanHash = 1; }],
    ["invalid backup", value => { value.snapshotJson.backupFile = {}; }],
    ["missing backup", value => { delete value.snapshotJson.backupFile; }],
  ];
  it.each(corruptions)("fails closed for %s after a valid review without returning partial references", async (_name, corrupt) => {
    const bad = row("review_required", 2);
    corrupt(bad);
    await expect(rawDatabase([row(), bad]).read()).rejects.toThrow(message);
  });

  it.each(["succeeded", "rolled_back"] as const)("does not skip malformed %s records", async outcome => {
    const invalid = row(outcome, 2);
    candidate(invalid).id = otherId;
    await expect(rawDatabase([row(), invalid]).read()).rejects.toThrow(message);
  });

  it.each(["succeeded", "rolled_back", "review_required"] as const)("rejects duplicate operation IDs even for %s", async outcome => {
    await expect(rawDatabase([row(), row(outcome)]).read()).rejects.toThrow(message);
  });

  it("rejects case-varied duplicate UUIDs without conflating distinct reviews for one plugin", async () => {
    const duplicate = row("review_required");
    duplicate.id = duplicate.id.toUpperCase();
    await expect(rawDatabase([row(), duplicate]).read()).rejects.toThrow(message);
    await expect(rawDatabase([row(), row("review_required", 2)]).read()).resolves.toHaveLength(2);
  });

  it("accepts exactly 60,000 validated rows and keeps the last review rather than truncating", async () => {
    const base = row("succeeded");
    const rows = Array.from({ length: 60_000 }, (_, index) => ({ ...base, id: operationId(index + 1) }));
    rows[rows.length - 1] = row("review_required", 60_000);
    const result = await rawDatabase(rows).read();
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(operationId(60_000));
  }, 20_000);

  it("rejects the 60,001st row before accepting an incomplete bounded observation", async () => {
    await expect(rawDatabase(Array(60_001).fill(row("succeeded"))).read()).rejects.toThrow(message);
  });

  it.each([null, {}, [null]])("rejects an unavailable raw rowset %j", async rows => {
    await expect(rawDatabase(rows).read()).rejects.toThrow(message);
  });

  it("propagates a failed DB read instead of claiming an empty retained set", async () => {
    const db = rawDatabase([]);
    const failure = new Error("synthetic read failure");
    db.limit.mockRejectedValueOnce(failure);
    await expect(db.read()).rejects.toBe(failure);
  });
});
