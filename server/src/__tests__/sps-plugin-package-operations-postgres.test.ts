import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1, PluginRecord } from "@paperclipai/shared";
import { createDb, plugins, sanitizePostRestoreDatabase, spsPluginPackageOperations, type Db } from "@paperclipai/db";
import { createSpsPluginPackageOperations } from "../services/sps-plugin-package-operations.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping SPS plugin package operations PostgreSQL checks: ${support.reason ?? "unsupported environment"}`);
}

describePostgres("SPS plugin package operation persistence", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtureStartup: Promise<Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>> | undefined;
  let db: Db | undefined;
  const clients: Db[] = [];

  // The standalone owned-fixture diagnostic measured 57s for fresh PostgreSQL
  // initialization plus all migrations on Windows. This is setup allowance,
  // not a product startup/closure deadline; assertion and cleanup limits stay.
  beforeAll(async () => {
    fixtureStartup = startEmbeddedPostgresTestDatabase("sps-plugin-package-operations-");
    fixture = await fixtureStartup;
    db = createDb(fixture.connectionString);
    clients.push(db);
  }, 90_000);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (!fixture && fixtureStartup) fixture = await fixtureStartup;
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const client of clients) {
      try {
        await client.$client.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await fixture?.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "SPS plugin package operation PostgreSQL fixture cleanup failed.");
    }
  }, 30_000);

  async function insertPlugin(overrides: Partial<{
    id: string;
    pluginKey: string;
    status: string;
    manifestJson: unknown;
  }> = {}): Promise<PluginRecord> {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const id = overrides.id ?? randomUUID();
    const pluginKey = overrides.pluginKey ?? `sps.package-operation-${id}`;
    const manifestJson = overrides.manifestJson ?? {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Private npm package operations fixture",
      description: "Durable package lifecycle test fixture.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["companies.read"],
      entrypoints: { worker: "./dist/worker.js" },
    } satisfies PaperclipPluginManifestV1;
    const [row] = await db.insert(plugins).values({
      id,
      pluginKey,
      packageName: "@sps/private-npm-package-operations-fixture",
      version: "1.0.0",
      categories: ["automation"],
      manifestJson: manifestJson as PaperclipPluginManifestV1,
      status: (overrides.status ?? "ready") as PluginRecord["status"],
      packagePath: null,
    }).returning();
    if (!row) throw new Error("Could not insert plugin fixture.");
    return row as PluginRecord;
  }

  function upgradeCandidate(plugin: PluginRecord): PluginRecord {
    const manifest = { ...plugin.manifestJson, version: "2.0.0" };
    return {
      ...plugin,
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      version: "2.0.0",
      manifestJson: manifest,
    };
  }

  function upgradeOptions(overrides: Partial<{
    databaseMayChange: boolean;
    approvedMigrationPlanHash: string | null;
    backupFile: string | null;
  }> = {}) {
    return {
      databaseMayChange: true,
      approvedMigrationPlanHash: "migration-plan-hash",
      backupFile: "C:\\backups\\before-upgrade.sql.gz",
      ...overrides,
    };
  }

  function persistedJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  it("commits the uninstall journal and non-running plugin status together and survives a DB reopen", async () => {
    if (!db || !fixture) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const operation = createSpsPluginPackageOperations(db);
    const intent = await operation.beginUninstall(plugin, false);

    const [updatedPlugin] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    expect(updatedPlugin?.status).toBe("error");
    expect(updatedPlugin?.lastError).toMatch(/requires recovery/);
    expect(await db.select().from(spsPluginPackageOperations)
      .where(eq(spsPluginPackageOperations.id, intent.id))).toHaveLength(1);

    await db.$client.end();
    clients.splice(clients.indexOf(db), 1);
    const reopenedDb = createDb(fixture.connectionString);
    clients.push(reopenedDb);
    db = reopenedDb;
    const recovered = await createSpsPluginPackageOperations(reopenedDb).pendingForPlugin(plugin.id);
    expect(recovered).toMatchObject({ id: intent.id, pluginId: plugin.id, pluginKey: plugin.pluginKey, removeData: false });
  });

  it("returns the existing intent idempotently and rejects a conflicting removal policy", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const firstStore = createSpsPluginPackageOperations(db);
    const secondStore = createSpsPluginPackageOperations(db);
    const first = await firstStore.beginUninstall(plugin, false);
    const repeated = await secondStore.beginUninstall(plugin, false);

    expect(repeated).toEqual(first);
    await expect(secondStore.beginUninstall(plugin, true)).rejects.toThrow(/requires recovery/);
  });

  it("blocks package operations by either plugin id or key until completion, even after hard delete", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const operations = createSpsPluginPackageOperations(db);
    const intent = await operations.beginUninstall(plugin, true);

    await expect(operations.assertClear(plugin.id)).rejects.toThrow(/requires recovery/);
    await expect(operations.assertClear(undefined, plugin.pluginKey)).rejects.toThrow(/requires recovery/);

    await db.delete(plugins).where(eq(plugins.id, plugin.id));
    expect(await db.select().from(spsPluginPackageOperations)
      .where(eq(spsPluginPackageOperations.id, intent.id))).toHaveLength(1);

    await operations.complete(intent.id);
    expect(await operations.pendingForPlugin(plugin.id)).toBeNull();
    await operations.assertClear(plugin.id);
    await operations.assertClear(undefined, plugin.pluginKey);
  });

  it("rolls back a failed journal insert without changing plugin status", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const pluginKey = `sps.invalid-snapshot-${randomUUID()}`;
    const plugin = await insertPlugin({
      pluginKey,
      manifestJson: { id: pluginKey },
    });
    const operations = createSpsPluginPackageOperations(db);

    await expect(operations.beginUninstall(plugin, false)).rejects.toThrow(/could not be reconciled|invalid/i);
    const [unchanged] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    expect(unchanged?.status).toBe("ready");
    expect(await db.select().from(spsPluginPackageOperations).where(eq(spsPluginPackageOperations.pluginId, plugin.id))).toEqual([]);
  });

  it("rejects an invalid pending journal kind", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const operations = createSpsPluginPackageOperations(db);
    const intent = await operations.beginUninstall(plugin, false);
    await db.update(spsPluginPackageOperations).set({ kind: "unsupported" })
      .where(eq(spsPluginPackageOperations.id, intent.id));

    await expect(operations.pendingForPlugin(plugin.id)).rejects.toThrow(/recovery record is invalid/);
  });

  it("retires package recovery intent after restoring a different Host backup while preserving history", async () => {
    if (!db || !fixture) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const operations = createSpsPluginPackageOperations(db);
    const intent = await operations.beginUninstall(plugin, true);

    await sanitizePostRestoreDatabase(fixture.connectionString);

    const restoredStore = createSpsPluginPackageOperations(db);
    expect(await restoredStore.pendingForPlugin(plugin.id)).toBeNull();
    const [retired] = await db.select().from(spsPluginPackageOperations)
      .where(eq(spsPluginPackageOperations.id, intent.id));
    expect(retired).toMatchObject({
      id: intent.id,
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      kind: "cancelled_after_restore",
      activePluginId: null,
      completedAt: expect.any(Date),
      snapshotJson: intent.snapshot,
      removeData: true,
    });
    const [preservedPlugin] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    expect(preservedPlugin).toMatchObject({
      id: plugin.id,
      pluginKey: plugin.pluginKey,
      version: plugin.version,
      manifestJson: plugin.manifestJson,
      status: "uninstalled",
      packagePath: null,
      lastError: "Host restore requires review before reinstall; plugin data was retained.",
    });
  });

  it("persists previous and candidate upgrade snapshots, backup, and approval hash across DB reopen", async () => {
    if (!db || !fixture) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const candidate = upgradeCandidate(plugin);
    const journal = createSpsPluginPackageOperations(db).upgrade;
    if (!journal) throw new Error("Upgrade recovery journal is unavailable.");
    const intent = await journal.begin(plugin, candidate, upgradeOptions());

    expect(intent).toMatchObject({
      kind: "upgrade",
      phase: "prepared",
      snapshot: persistedJson(plugin),
      candidate: persistedJson(candidate),
      databaseMayChange: true,
      approvedMigrationPlanHash: "migration-plan-hash",
      backupFile: "C:\\backups\\before-upgrade.sql.gz",
    });
    await db.$client.end();
    clients.splice(clients.indexOf(db), 1);
    const reopenedDb = createDb(fixture.connectionString);
    clients.push(reopenedDb);
    db = reopenedDb;

    const recovered = await createSpsPluginPackageOperations(reopenedDb).pendingForPlugin(plugin.id);
    expect(recovered).toMatchObject({
      id: intent.id,
      kind: "upgrade",
      phase: "prepared",
      snapshot: persistedJson(plugin),
      candidate: persistedJson(candidate),
      databaseMayChange: true,
      approvedMigrationPlanHash: "migration-plan-hash",
      backupFile: "C:\\backups\\before-upgrade.sql.gz",
    });
  });

  it("allows only its active upgrade operation through assertClear", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const otherPlugin = await insertPlugin();
    const store = createSpsPluginPackageOperations(db);
    const journal = store.upgrade;
    if (!journal) throw new Error("Upgrade recovery journal is unavailable.");
    const intent = await journal.begin(plugin, upgradeCandidate(plugin), upgradeOptions());
    await store.beginUninstall(otherPlugin, false);

    await journal.run(intent.id, async () => {
      await store.assertClear(plugin.id);
      await store.assertClear(undefined, plugin.pluginKey);
      await expect(store.assertClear(otherPlugin.id)).rejects.toMatchObject({
        details: { code: "sps_plugin_package_recovery_required" },
      });
      await expect(store.assertClear(undefined, otherPlugin.pluginKey)).rejects.toMatchObject({
        details: { code: "sps_plugin_package_recovery_required" },
      });
    });
  });

  it("revokes assertClear authority from continuations after the upgrade run returns", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const store = createSpsPluginPackageOperations(db);
    const journal = store.upgrade;
    if (!journal) throw new Error("Upgrade recovery journal is unavailable.");
    const intent = await journal.begin(plugin, upgradeCandidate(plugin), upgradeOptions());
    let releaseContinuation!: () => void;
    let continuation!: Promise<void>;

    await journal.run(intent.id, async () => {
      const deferred = new Promise<void>(resolve => { releaseContinuation = resolve; });
      continuation = deferred.then(() => store.assertClear(plugin.id));
    });
    releaseContinuation();

    await expect(continuation).rejects.toMatchObject({
      details: { code: "sps_plugin_package_recovery_required" },
    });
  });

  it("stores upgrade phases in order and rejects skips, rewinds, and outside advancement", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const store = createSpsPluginPackageOperations(db);
    const journal = store.upgrade;
    if (!journal) throw new Error("Upgrade recovery journal is unavailable.");
    const intent = await journal.begin(plugin, upgradeCandidate(plugin), upgradeOptions());

    await journal.run(intent.id, async () => {
      await expect(journal.advance(intent.id, "committed")).rejects.toThrow(/cannot be skipped or rewound/);
      await journal.advance(intent.id, "prepared");
      await journal.advance(intent.id, "committing");
      await expect(journal.advance(intent.id, "prepared")).rejects.toThrow(/cannot be skipped or rewound/);
      await journal.advance(intent.id, "committed");
      await journal.advance(intent.id, "activation_entered");
    });
    await expect(journal.advance(intent.id, "activation_entered")).rejects.toThrow(/outside its active operation/);

    expect(await store.pendingForPlugin(plugin.id)).toMatchObject({ id: intent.id, kind: "upgrade", phase: "activation_entered" });
  });

  it("does not complete an upgrade as succeeded before activation is entered", async () => {
    if (!db) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const store = createSpsPluginPackageOperations(db);
    const intent = await store.upgrade!.begin(plugin, upgradeCandidate(plugin), upgradeOptions());

    await expect(store.complete(intent.id, "succeeded")).rejects.toThrow(/cannot succeed before entering activation/);
    expect(await store.pendingForPlugin(plugin.id)).toMatchObject({ id: intent.id, kind: "upgrade", phase: "prepared" });
  });

  it("persists rollback_required across reopen and permits only rolled-back completion", async () => {
    if (!db || !fixture) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const candidate = upgradeCandidate(plugin);
    const store = createSpsPluginPackageOperations(db);
    const journal = store.upgrade;
    if (!journal) throw new Error("Upgrade recovery journal is unavailable.");
    const intent = await journal.begin(plugin, candidate, upgradeOptions());

    await journal.run(intent.id, async () => {
      await journal.advance(intent.id, "rollback_required");
      await expect(journal.advance(intent.id, "committing")).rejects.toThrow(/cannot be skipped or rewound/);
      await expect(store.complete(intent.id, "succeeded")).rejects.toThrow(/cannot succeed before entering activation/);
    });

    await db.$client.end();
    clients.splice(clients.indexOf(db), 1);
    const reopenedDb = createDb(fixture.connectionString);
    clients.push(reopenedDb);
    db = reopenedDb;
    const reopenedStore = createSpsPluginPackageOperations(reopenedDb);
    expect(await reopenedStore.pendingForPlugin(plugin.id)).toMatchObject({
      id: intent.id,
      kind: "upgrade",
      phase: "rollback_required",
      snapshot: persistedJson(plugin),
      candidate: persistedJson(candidate),
      databaseMayChange: true,
      approvedMigrationPlanHash: "migration-plan-hash",
      backupFile: "C:\\backups\\before-upgrade.sql.gz",
    });

    await reopenedStore.complete(intent.id, "rolled_back");
    expect(await reopenedStore.pendingForPlugin(plugin.id)).toBeNull();
  });

  it("cancels upgrade intent after restoring another Host backup and preserves its snapshots", async () => {
    if (!db || !fixture) throw new Error("Embedded PostgreSQL fixture is not ready.");
    const plugin = await insertPlugin();
    const candidate = upgradeCandidate(plugin);
    const store = createSpsPluginPackageOperations(db);
    const intent = await store.upgrade!.begin(plugin, candidate, upgradeOptions());

    await sanitizePostRestoreDatabase(fixture.connectionString);

    expect(await store.pendingForPlugin(plugin.id)).toBeNull();
    const [retired] = await db.select().from(spsPluginPackageOperations)
      .where(eq(spsPluginPackageOperations.id, intent.id));
    expect(retired).toMatchObject({
      id: intent.id,
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      kind: "cancelled_after_restore",
      activePluginId: null,
      completedAt: expect.any(Date),
      snapshotJson: expect.objectContaining({ previous: persistedJson(plugin), candidate: persistedJson(candidate), phase: "prepared" }),
      removeData: false,
    });
    const [preservedPlugin] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    expect(preservedPlugin).toMatchObject({
      id: plugin.id,
      pluginKey: plugin.pluginKey,
      version: plugin.version,
      manifestJson: plugin.manifestJson,
      status: "uninstalled",
      packagePath: null,
      lastError: "Host restore requires review before reinstall; plugin data was retained.",
    });
  });
});
