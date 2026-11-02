import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginId = "11111111-1111-4111-8111-111111111111";
const oldManifest = {
  id: "example.plugin",
  version: "1.0.0",
  apiVersion: 1,
  capabilities: [],
};
const candidateManifest = {
  ...oldManifest,
  version: "1.1.0",
};

let currentPlugin: Record<string, unknown>;

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
}));
const mockPluginDatabase = vi.hoisted(() => ({
  inspectMigrations: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-database.js", () => ({
  pluginDatabaseService: () => mockPluginDatabase,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";

function resetPlugin(status = "ready") {
  currentPlugin = {
    id: pluginId,
    pluginKey: "example.plugin",
    status,
    lastError: null,
    packageName: "@example/plugin",
    packagePath: "C:\\plugins\\example-1.0.0",
    version: "1.0.0",
    manifestJson: oldManifest,
  };
  mockRegistry.getById.mockImplementation(async () => currentPlugin);
  mockRegistry.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => {
    currentPlugin = {
      ...currentPlugin,
      ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
      ...(input.packagePath === undefined ? {} : { packagePath: input.packagePath }),
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.manifest === undefined ? {} : { manifestJson: input.manifest }),
    };
    return currentPlugin;
  });
  mockRegistry.updateStatus.mockImplementation(async (_id: string, input: { status: string; lastError?: string | null }) => {
    currentPlugin = {
      ...currentPlugin,
      status: input.status,
      lastError: input.lastError ?? null,
    };
    return currentPlugin;
  });
}

function preparedUpgrade(manifest = candidateManifest) {
  return {
    oldManifest,
    newManifest: manifest,
    discovered: {
      packageName: "@example/plugin",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      version: manifest.version,
      source: "local-filesystem",
      manifest,
    },
  };
}

function makeLoader(overrides: Partial<PluginLoader> = {}): PluginLoader {
  return {
    hasRuntimeServices: vi.fn().mockReturnValue(true),
    unloadSingle: vi.fn().mockResolvedValue(undefined),
    loadSingle: vi.fn().mockResolvedValue({
      success: true,
      plugin: currentPlugin,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
    }),
    prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade()),
    commitPreparedUpgrade: vi.fn().mockImplementation(async (_id, prepared) => {
      currentPlugin = {
        ...currentPlugin,
        packageName: prepared.discovered.packageName,
        packagePath: prepared.discovered.packagePath,
        version: prepared.discovered.version,
        manifestJson: prepared.newManifest,
      };
    }),
    ...overrides,
  } as unknown as PluginLoader;
}

function makeWorkerManager(overrides: Record<string, unknown> = {}) {
  return {
    getWorker: vi.fn(() => undefined),
    stopWorker: vi.fn().mockResolvedValue(undefined),
    withPluginPackageMutation: vi.fn(async (_pluginId: string, action: () => Promise<unknown>) => action()),
    ...overrides,
  };
}

function createLifecycle(
  loader: PluginLoader,
  workerManager = makeWorkerManager(),
  options: { migrationDb?: unknown; databaseBackupService?: { runManualBackup: ReturnType<typeof vi.fn> } } = {},
) {
  return pluginLifecycleManager({} as never, {
    loader,
    workerManager: workerManager as never,
    ...(options.migrationDb === undefined ? {} : { migrationDb: options.migrationDb as never }),
    ...(options.databaseBackupService === undefined ? {} : { databaseBackupService: options.databaseBackupService }),
  });
}

function approvedDatabaseUpgrade() {
  const manifest = { ...candidateManifest, database: { migrationsDir: "./migrations" } };
  const plan = {
    pluginId,
    pluginKey: "example.plugin",
    targetVersion: "1.1.0",
    namespaceName: "plugin_example",
    hasAppliedMigrations: true,
    requiresHostApproval: true,
    reviewHash: "approved-migration-plan-hash",
    pendingMigrations: [{ migrationKey: "001_add_table.sql", checksum: "abc", statementCount: 1, operationKinds: ["create"] }],
  };
  mockPluginDatabase.inspectMigrations.mockResolvedValue(plan);
  return { manifest, plan };
}

function approvedDatabaseUpgradeInput() {
  return { version: "1.1.0", approvedDataMigrationPlanHash: "approved-migration-plan-hash" };
}

describe("pluginLifecycleManager.upgrade failure safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPlugin();
    mockPluginDatabase.inspectMigrations.mockReset();
  });

  it("does not unload handlers or disable the plugin while its worker remains", async () => {
    const retainedWorker = { status: "running" };
    const workerManager = makeWorkerManager({
      getWorker: vi.fn(() => retainedWorker),
      stopWorker: vi.fn().mockResolvedValue(undefined),
    });
    const loader = makeLoader();
    const lifecycle = createLifecycle(loader, workerManager);

    await expect(lifecycle.disable(pluginId)).rejects.toMatchObject({
      code: "plugin_package_maintenance_required",
    });

    expect(workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: "C:\\plugins\\example-1.0.0" });
  });

  it("keeps the ready runtime and registry record when preparation fails", async () => {
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockRejectedValue(new Error("candidate manifest is invalid")),
    });
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("candidate manifest is invalid");

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("retries the original ready runtime when unload fails after partial teardown", async () => {
    const loader = makeLoader({
      unloadSingle: vi.fn().mockRejectedValueOnce(new Error("worker stopped before route cleanup failed")),
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: currentPlugin,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }),
    });
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("worker stopped before route cleanup failed");

    expect(loader.unloadSingle).toHaveBeenCalledOnce();
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(loader.loadSingle).toHaveBeenCalledWith(pluginId);
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("restores the old record and reactivates its runtime when new activation fails", async () => {
    const loadSingle = vi
      .fn()
      .mockResolvedValueOnce({ success: false, plugin: currentPlugin, error: "candidate worker failed" })
      .mockResolvedValueOnce({ success: true, plugin: currentPlugin, registered: {} });
    const loader = makeLoader({ loadSingle });
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("candidate worker failed");

    expect(loader.unloadSingle).toHaveBeenCalledTimes(2);
    expect(loader.unloadSingle).toHaveBeenNthCalledWith(2, pluginId, "example.plugin");
    expect(loadSingle).toHaveBeenCalledTimes(2);
    expect(mockRegistry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifest: oldManifest,
    }));
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });

  it.each(["disabled", "error"])("unloads a partially registered candidate and restores an originally %s plugin", async (status) => {
    resetPlugin(status);
    const loadSingle = vi.fn().mockResolvedValue({
      success: false,
      plugin: currentPlugin,
      error: "candidate worker registered routes before failing",
    });
    const loader = makeLoader({ loadSingle });
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("candidate worker registered routes before failing");

    // The old disabled/error runtime was never started. The only unload is
    // rollback cleanup for the partially registered candidate.
    expect(loader.unloadSingle).toHaveBeenCalledTimes(1);
    expect(loader.unloadSingle).toHaveBeenCalledWith(pluginId, "example.plugin");
    expect(loadSingle).toHaveBeenCalledOnce();
    expect(currentPlugin).toMatchObject({
      status,
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("reports candidate cleanup failure together with the activation failure", async () => {
    resetPlugin("disabled");
    const loader = makeLoader({
      loadSingle: vi.fn().mockResolvedValue({
        success: false,
        plugin: currentPlugin,
        error: "candidate worker failed",
      }),
      unloadSingle: vi.fn().mockRejectedValue(new Error("candidate cleanup failed")),
    });
    const lifecycle = createLifecycle(loader);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow(
      /candidate worker failed.*candidate runtime closure or rollback failed: candidate cleanup failed/i,
    );
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      manifestJson: candidateManifest,
    });
  });

  it("keeps the candidate pointer when its worker cannot be closed during rollback", async () => {
    let candidateStarted = false;
    const retainedCandidateWorker = { status: "running" };
    const workerManager = makeWorkerManager({
      getWorker: vi.fn(() => candidateStarted ? retainedCandidateWorker : undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
    });
    const loader = makeLoader({
      loadSingle: vi.fn().mockImplementation(async () => {
        candidateStarted = true;
        return { success: false, plugin: currentPlugin, error: "candidate worker failed" };
      }),
    });
    const lifecycle = createLifecycle(loader, workerManager);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow(
      /candidate worker failed.*candidate runtime closure or rollback failed/i,
    );

    expect(workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(loader.unloadSingle).toHaveBeenCalledOnce();
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(loader.loadSingle).toHaveBeenCalledOnce();
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      manifestJson: candidateManifest,
    });
  });

  it("keeps the reviewed upgrade_pending flow after candidate prevalidation", async () => {
    const reviewManifest = {
      ...candidateManifest,
      capabilities: ["tools.register"],
    };
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(reviewManifest)),
    });
    const lifecycle = createLifecycle(loader);

    const result = await lifecycle.upgrade(pluginId, "1.1.0");

    expect(result.status).toBe("upgrade_pending");
    expect(loader.unloadSingle).toHaveBeenCalledOnce();
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({
      status: "upgrade_pending",
      packagePath: "C:\\plugins\\example-1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("does not enter upgrade_pending while the prior worker handle remains", async () => {
    const retainedWorker = { status: "running" };
    const workerManager = makeWorkerManager({
      getWorker: vi.fn(() => retainedWorker),
      stopWorker: vi.fn().mockResolvedValue(undefined),
    });
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade({
        ...candidateManifest,
        capabilities: ["tools.register"],
      })),
    });
    const lifecycle = createLifecycle(loader, workerManager);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toMatchObject({
      code: "plugin_package_maintenance_required",
    });

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("does not commit or activate an upgrade while the prior worker handle remains", async () => {
    const retainedWorker = { status: "running" };
    const workerManager = makeWorkerManager({
      getWorker: vi.fn(() => retainedWorker),
      stopWorker: vi.fn().mockResolvedValue(undefined),
    });
    const loader = makeLoader();
    const lifecycle = createLifecycle(loader, workerManager);

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toMatchObject({
      code: "plugin_package_maintenance_required",
    });

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("commits and activates a successful candidate", async () => {
    const loader = makeLoader();
    const lifecycle = createLifecycle(loader);

    const result = await lifecycle.upgrade(pluginId, "1.1.0");

    expect(result.status).toBe("ready");
    expect(loader.unloadSingle).toHaveBeenCalledOnce();
    expect(loader.commitPreparedUpgrade).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledWith(pluginId);
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      version: "1.1.0",
      manifestJson: candidateManifest,
    });
  });

  it("accepts a different development artifact with the same version", async () => {
    const sameVersionArtifact = {
      ...oldManifest,
      displayName: "Example plugin rebuilt locally",
    };
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(sameVersionArtifact)),
    });
    const lifecycle = createLifecycle(loader);

    const result = await lifecycle.upgrade(pluginId, { localPath: "C:\\source\\example-plugin" });

    expect(result.status).toBe("ready");
    expect(loader.commitPreparedUpgrade).toHaveBeenCalledOnce();
    expect(currentPlugin).toMatchObject({
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      version: "1.0.0",
      manifestJson: sameVersionArtifact,
    });
  });

  it("preserves an approved migration candidate when failed activation may have committed its schema", async () => {
    const { manifest } = approvedDatabaseUpgrade();
    const backup = { runManualBackup: vi.fn().mockResolvedValue({ backupFile: "C:\\backups\\before-upgrade.sql.gz" }) };
    const loadSingle = vi.fn().mockResolvedValue({ success: false, plugin: currentPlugin, error: "candidate worker failed after migration" });
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(manifest)),
      loadSingle,
    });
    const lifecycle = createLifecycle(loader, makeWorkerManager(), { migrationDb: {}, databaseBackupService: backup });

    await expect(lifecycle.upgrade(pluginId, approvedDatabaseUpgradeInput())).rejects.toMatchObject({
      details: { code: "plugin_upgrade_data_recovery_required" },
    });

    expect(mockPluginDatabase.inspectMigrations).toHaveBeenCalledWith(pluginId, manifest, "C:\\plugins\\.upgrade-staging\\candidate");
    expect(backup.runManualBackup).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledWith(pluginId, { approvedMigrationPlanHash: "approved-migration-plan-hash" });
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith(pluginId, expect.objectContaining({ status: "error" }));
    expect(currentPlugin).toMatchObject({
      status: "error",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      version: "1.1.0",
      manifestJson: manifest,
    });
  });

  it("does not restore or reactivate old code when a migrated candidate cannot be confirmed closed", async () => {
    const { manifest } = approvedDatabaseUpgrade();
    const backup = { runManualBackup: vi.fn().mockResolvedValue({ backupFile: "C:\\backups\\before-upgrade.sql.gz" }) };
    let candidateStarted = false;
    const retainedCandidateWorker = { status: "running" };
    const workerManager = makeWorkerManager({
      getWorker: vi.fn(() => candidateStarted ? retainedCandidateWorker : undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
    });
    const loadSingle = vi.fn().mockImplementation(async () => {
      candidateStarted = true;
      return { success: false, plugin: currentPlugin, error: "candidate worker failed after migration" };
    });
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(manifest)),
      loadSingle,
    });
    const lifecycle = createLifecycle(loader, workerManager, { migrationDb: {}, databaseBackupService: backup });

    await expect(lifecycle.upgrade(pluginId, approvedDatabaseUpgradeInput())).rejects.toMatchObject({
      details: { code: "plugin_upgrade_data_recovery_required" },
    });

    expect(workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(mockRegistry.update).not.toHaveBeenCalled();
    expect(loadSingle).toHaveBeenCalledOnce();
    expect(currentPlugin).toMatchObject({
      status: "error",
      packagePath: "C:\\plugins\\.upgrade-staging\\candidate",
      manifestJson: manifest,
    });
  });

  it("retains the ordinary rollback for a database candidate with no pending migrations", async () => {
    const manifest = { ...candidateManifest, database: { migrationsDir: "./migrations" } };
    mockPluginDatabase.inspectMigrations.mockResolvedValue({
      pluginId,
      pluginKey: "example.plugin",
      targetVersion: "1.1.0",
      namespaceName: "plugin_example",
      hasAppliedMigrations: true,
      requiresHostApproval: false,
      reviewHash: "empty-migration-plan-hash",
      pendingMigrations: [],
    });
    const loadSingle = vi.fn()
      .mockResolvedValueOnce({ success: false, plugin: currentPlugin, error: "candidate activation failed" })
      .mockResolvedValueOnce({ success: true, plugin: currentPlugin, registered: {} });
    const loader = makeLoader({ prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(manifest)), loadSingle });
    const lifecycle = createLifecycle(loader, makeWorkerManager(), { migrationDb: {} });

    await expect(lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("candidate activation failed");

    expect(loader.loadSingle).toHaveBeenCalledTimes(2);
    expect(mockRegistry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifest: oldManifest,
    }));
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });

  it("keeps the old rollback when candidate commit fails before activation despite pending migrations", async () => {
    const { manifest } = approvedDatabaseUpgrade();
    const backup = { runManualBackup: vi.fn().mockResolvedValue({ backupFile: "C:\\backups\\before-upgrade.sql.gz" }) };
    const loader = makeLoader({
      prepareUpgrade: vi.fn().mockResolvedValue(preparedUpgrade(manifest)),
      commitPreparedUpgrade: vi.fn().mockRejectedValue(new Error("candidate commit failed")),
    });
    const lifecycle = createLifecycle(loader, makeWorkerManager(), { migrationDb: {}, databaseBackupService: backup });

    await expect(lifecycle.upgrade(pluginId, approvedDatabaseUpgradeInput())).rejects.toThrow("candidate commit failed");

    expect(backup.runManualBackup).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledOnce();
    expect(mockRegistry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifest: oldManifest,
    }));
    expect(currentPlugin).toMatchObject({
      status: "ready",
      packagePath: "C:\\plugins\\example-1.0.0",
      version: "1.0.0",
      manifestJson: oldManifest,
    });
  });
});
