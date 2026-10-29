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

    await expect(operations.listPending()).rejects.toThrow(/recovery record is invalid/);
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
      kind: "cancelled_after_restore",
      activePluginId: null,
      completedAt: expect.any(Date),
      snapshotJson: intent.snapshot,
      removeData: true,
    });
    const [preservedPlugin] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    expect(preservedPlugin?.status).toBe("error");
  });
});
