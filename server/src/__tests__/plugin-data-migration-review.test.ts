import { describe, expect, it, vi } from "vitest";

const pluginId = "11111111-1111-4111-8111-111111111111";
const planHash = "reviewed-migration-plan-hash";
const pluginRecord = {
  id: pluginId,
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: {
    id: "example.plugin",
    version: "1.0.0",
    capabilities: [],
    database: { migrationsDir: "migrations" },
  },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
}));
const mockInspectMigrations = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-database.js", () => ({
  pluginDatabaseService: () => ({ inspectMigrations: mockInspectMigrations }),
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

function makeLoader(): PluginLoader {
  return {
    hasRuntimeServices: vi.fn().mockReturnValue(true),
    loadSingle: vi.fn().mockResolvedValue({
      success: true,
      plugin: pluginRecord,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
    }),
    unloadSingle: vi.fn().mockResolvedValue(undefined),
    prepareUpgrade: vi.fn().mockResolvedValue({
      oldManifest: pluginRecord.manifestJson,
      newManifest: {
        ...pluginRecord.manifestJson,
        version: "1.1.0",
      },
      discovered: {
        packagePath: "/tmp/example-plugin-1.1.0",
        version: "1.1.0",
      },
    }),
    commitPreparedUpgrade: vi.fn().mockResolvedValue(undefined),
  } as unknown as PluginLoader;
}

function makeWorkerManager() {
  return {
    getWorker: vi.fn(() => undefined),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    withPluginPackageMutation: vi.fn(async (_pluginId: string, action: () => Promise<unknown>) => action()),
  };
}

function setupRegistry(status = "ready") {
  mockRegistry.getById.mockResolvedValue({ ...pluginRecord, status });
  mockRegistry.updateStatus.mockImplementation(async (_id: string, update: { status: string; lastError?: string | null }) => ({
    ...pluginRecord,
    status: update.status,
    lastError: update.lastError ?? null,
  }));
}

function reviewedPlan() {
  return {
    pluginId,
    pluginKey: "example.plugin",
    targetVersion: "1.1.0",
    namespaceName: "plugin_example",
    hasAppliedMigrations: true,
    requiresHostApproval: true,
    reviewHash: planHash,
    pendingMigrations: [{
      migrationKey: "002_add_state.sql",
      checksum: "checksum",
      statementCount: 1,
      operationKinds: ["alter"],
    }],
  };
}

describe("plugin data migration review", () => {
  it("keeps an upgrade pending until its exact data migration plan is approved", async () => {
    setupRegistry();
    mockInspectMigrations.mockResolvedValue(reviewedPlan());
    const loader = makeLoader();
    const backup = { runManualBackup: vi.fn() };
    const lifecycle = pluginLifecycleManager({} as never, {
      loader,
      workerManager: makeWorkerManager() as never,
      databaseBackupService: backup,
    });

    const result = await lifecycle.upgrade(pluginId, "1.1.0");

    expect(result.status).toBe("upgrade_pending");
    expect(backup.runManualBackup).not.toHaveBeenCalled();
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });

  it("backs up and activates only after the exact reviewed migration plan is approved", async () => {
    setupRegistry("upgrade_pending");
    mockInspectMigrations.mockResolvedValue(reviewedPlan());
    const loader = makeLoader();
    const backup = {
      runManualBackup: vi.fn().mockResolvedValue({ backupFile: "C:\\vault\\backups\\before-migration.sql.gz" }),
    };
    const lifecycle = pluginLifecycleManager({} as never, {
      loader,
      workerManager: makeWorkerManager() as never,
      databaseBackupService: backup,
    });

    const result = await lifecycle.upgrade(pluginId, {
      version: "1.1.0",
      approvedDataMigrationPlanHash: planHash,
    });

    expect(result.status).toBe("ready");
    expect(backup.runManualBackup).toHaveBeenCalledOnce();
    expect(loader.commitPreparedUpgrade).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledWith(pluginId, {
      approvedMigrationPlanHash: planHash,
    });
  });

  it("does not allow direct enable to bypass an upgrade review", async () => {
    setupRegistry("upgrade_pending");
    const lifecycle = pluginLifecycleManager({} as never, { loader: makeLoader() });

    await expect(lifecycle.enable(pluginId)).rejects.toThrow(/waiting for review/i);
  });
});
