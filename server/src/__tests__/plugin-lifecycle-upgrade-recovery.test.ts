import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginId = "11111111-1111-4111-8111-111111111111";
const oldManifest = { id: "example.plugin", version: "1.0.0", apiVersion: 1, capabilities: [] };
const candidateManifest = { ...oldManifest, version: "1.1.0" };
const oldPath = "C:\\plugins\\example-1.0.0";
const candidatePath = "C:\\plugins\\.upgrade-staging\\candidate";

let currentPlugin: Record<string, unknown>;

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

function resetRegistry(status = "ready", packagePath = oldPath) {
  currentPlugin = {
    id: pluginId,
    pluginKey: "example.plugin",
    status,
    lastError: null,
    packageName: "@example/plugin",
    packagePath,
    version: packagePath === oldPath ? "1.0.0" : "1.1.0",
    manifestJson: packagePath === oldPath ? oldManifest : candidateManifest,
  };
  registry.getById.mockImplementation(async () => currentPlugin);
  registry.update.mockImplementation(async (_id: string, input: Record<string, unknown>) => {
    currentPlugin = {
      ...currentPlugin,
      ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
      ...(input.packagePath === undefined ? {} : { packagePath: input.packagePath }),
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.manifest === undefined ? {} : { manifestJson: input.manifest }),
    };
    return currentPlugin;
  });
  registry.updateStatus.mockImplementation(async (_id: string, input: { status: string; lastError?: string | null }) => {
    currentPlugin = { ...currentPlugin, status: input.status, lastError: input.lastError ?? null };
    return currentPlugin;
  });
}

function makeUpgradeOperation(
  phase: "prepared" | "committing" | "committed" | "activation_entered" | "rollback_required",
  databaseMayChange: boolean,
) {
  const snapshot = {
    id: pluginId,
    pluginKey: "example.plugin",
    status: "ready",
    lastError: null,
    packageName: "@example/plugin",
    packagePath: oldPath,
    version: "1.0.0",
    manifestJson: oldManifest,
  };
  const candidate = {
    ...snapshot,
    status: "error",
    packagePath: candidatePath,
    version: "1.1.0",
    manifestJson: candidateManifest,
  };
  return {
    id: "operation-1",
    pluginId,
    pluginKey: snapshot.pluginKey,
    kind: "upgrade" as const,
    snapshot,
    candidate,
    phase,
    databaseMayChange,
    approvedMigrationPlanHash: null,
    backupFile: null,
  };
}

function setup(options: {
  status?: string;
  currentPath?: string;
  workerOpen?: boolean;
  closeWorker?: boolean;
  failBegin?: boolean;
  failAdvance?: string;
  loseSuccessfulCompleteResponse?: boolean;
  loseRollbackCompleteResponse?: boolean;
  clearAfterList?: boolean;
} = {}) {
  resetRegistry(options.status ?? "ready", options.currentPath ?? oldPath);
  const events: string[] = [];
  const pending = new Map<string, ReturnType<typeof makeUpgradeOperation>>();
  const outcomes: string[] = [];
  let operationContext: string | null = null;
  let worker: object | undefined = options.workerOpen ? {} : undefined;
  let activationResults: Array<{ success: boolean; error?: string }> = [];

  const packageOperations = {
    async assertClear(id?: string) {
      const active = id ? [...pending.values()].find(operation => operation.pluginId === id) : undefined;
      if (active && operationContext !== active.id) throw new Error("package recovery is pending");
    },
    async pendingForPlugin(id: string) {
      return [...pending.values()].find(operation => operation.pluginId === id) ?? null;
    },
    async listPending() {
      const listed = [...pending.values()];
      if (options.clearAfterList) pending.clear();
      return listed;
    },
    async beginUninstall() {
      throw new Error("uninstall is outside this fixture");
    },
    async complete(id: string, outcome?: string) {
      events.push(`complete:${outcome}`);
      if (options.loseRollbackCompleteResponse && outcome === "rolled_back") {
        throw new Error("rollback completion response lost");
      }
      outcomes.push(outcome ?? "");
      pending.delete(id);
      if (options.loseSuccessfulCompleteResponse && outcome === "succeeded") {
        throw new Error("database response lost after completion");
      }
    },
    upgrade: {
      async begin(snapshot: Record<string, unknown>, candidate: Record<string, unknown>, upgradeOptions: {
        databaseMayChange: boolean;
        approvedMigrationPlanHash: string | null;
        backupFile: string | null;
      }) {
        events.push("begin");
        if (options.failBegin) throw new Error("upgrade intent persistence failed");
        const operation = {
          ...makeUpgradeOperation("prepared", upgradeOptions.databaseMayChange),
          snapshot,
          candidate,
          approvedMigrationPlanHash: upgradeOptions.approvedMigrationPlanHash,
          backupFile: upgradeOptions.backupFile,
        };
        pending.set(operation.id, operation);
        await registry.updateStatus(pluginId, { status: "error", lastError: "Plugin package update requires recovery." });
        return operation;
      },
      async run<T>(id: string, action: () => Promise<T>): Promise<T> {
        if (!pending.has(id)) throw new Error("upgrade intent unavailable");
        operationContext = id;
        try {
          return await action();
        } finally {
          operationContext = null;
        }
      },
      async advance(id: string, phase: string) {
        if (operationContext !== id) throw new Error("upgrade intent context missing");
        events.push(`phase:${phase}`);
        if (options.failAdvance === phase) throw new Error(`phase persistence failed: ${phase}`);
        const operation = pending.get(id);
        if (operation) operation.phase = phase as typeof operation.phase;
      },
    },
    seed(operation = makeUpgradeOperation("committed", false)) {
      pending.set(operation.id, operation);
      return operation;
    },
    pending,
    events,
    outcomes,
  };

  const loader = {
    hasRuntimeServices: () => true,
    unloadSingle: vi.fn(async () => { events.push("unload"); }),
    prepareUpgrade: vi.fn(async () => {
      await packageOperations.assertClear(pluginId);
      return {
        oldManifest,
        newManifest: candidateManifest,
        discovered: {
          packageName: "@example/plugin",
          packagePath: candidatePath,
          version: candidateManifest.version,
          source: "local-filesystem",
          manifest: candidateManifest,
        },
      };
    }),
    commitPreparedUpgrade: vi.fn(async (_id: string, prepared: {
      discovered: { packageName: string; packagePath: string; version: string };
      newManifest: unknown;
    }) => {
      await packageOperations.assertClear(pluginId);
      events.push("commit");
      await registry.update(pluginId, {
        packageName: prepared.discovered.packageName,
        packagePath: prepared.discovered.packagePath,
        version: prepared.discovered.version,
        manifest: prepared.newManifest,
      });
    }),
    loadSingle: vi.fn(async () => {
      await packageOperations.assertClear(pluginId);
      events.push(`activation:${String(currentPlugin.packagePath)}`);
      const result = activationResults.shift() ?? { success: true };
      if (result.success) worker = {};
      return {
        ...result,
        plugin: currentPlugin,
        registered: { worker: result.success, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      };
    }),
  };
  const workerManager = {
    getWorker: vi.fn(() => worker),
    isRunning: vi.fn(() => Boolean(worker)),
    stopWorker: vi.fn(async () => {
      events.push("stop");
      if (options.closeWorker !== false) worker = undefined;
    }),
    withPluginPackageMutation: vi.fn(async (_id: string, action: () => Promise<unknown>) => action()),
    setActivationResults(results: Array<{ success: boolean; error?: string }>) { activationResults = [...results]; },
  };
  const lifecycle = pluginLifecycleManager({} as never, {
    loader: loader as never,
    workerManager: workerManager as never,
    packageOperations: packageOperations as never,
  });
  return { lifecycle, loader, workerManager, packageOperations, events, pending, outcomes };
}

describe("plugin lifecycle durable upgrade recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists every phase before activation and completes a successful upgrade", async () => {
    const fixture = setup();

    await fixture.lifecycle.upgrade(pluginId, "1.1.0");

    expect(fixture.events.filter(event => event === "begin" || event.startsWith("phase:")
      || event.startsWith("activation:") || event.startsWith("complete:"))).toEqual([
      "begin",
      "phase:committing",
      "phase:committed",
      "phase:activation_entered",
      `activation:${candidatePath}`,
      "complete:succeeded",
    ]);
    expect(fixture.outcomes).toEqual(["succeeded"]);
    expect(fixture.pending.size).toBe(0);
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: candidatePath, version: "1.1.0" });
  });

  it("leaves the old runtime untouched when persisting the upgrade intent fails", async () => {
    const fixture = setup({ workerOpen: true, failBegin: true });

    await expect(fixture.lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("upgrade intent persistence failed");

    expect(fixture.loader.unloadSingle).not.toHaveBeenCalled();
    expect(fixture.loader.commitPreparedUpgrade).not.toHaveBeenCalled();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.workerManager.stopWorker).not.toHaveBeenCalled();
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: oldPath, version: "1.0.0" });
  });

  it("does not enter candidate activation when a phase write fails and restores the old package", async () => {
    const fixture = setup({ failAdvance: "committed" });

    await expect(fixture.lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("phase persistence failed: committed");

    expect(fixture.loader.loadSingle).toHaveBeenCalledOnce();
    expect(fixture.events.filter(event => event.startsWith("activation:"))).toEqual([`activation:${oldPath}`]);
    expect(fixture.pending.size).toBe(0);
    expect(fixture.outcomes).toEqual(["rolled_back"]);
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: oldPath, version: "1.0.0" });
  });

  it("restores old metadata and status after interruption before activation without loading it", async () => {
    const fixture = setup({ currentPath: candidatePath });
    const operation = makeUpgradeOperation("committed", true);
    fixture.packageOperations.seed(operation);

    await fixture.lifecycle.recoverPackageOperations();

    expect(registry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({ packagePath: oldPath, version: "1.0.0" }));
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: oldPath, version: "1.0.0" });
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(0);
    expect(fixture.outcomes).toEqual(["rolled_back"]);
  });

  it("preserves the candidate in error for an interrupted activation that may have changed the database", async () => {
    const fixture = setup({ currentPath: candidatePath });
    fixture.packageOperations.seed(makeUpgradeOperation("activation_entered", true));

    await fixture.lifecycle.recoverPackageOperations();

    expect(currentPlugin).toMatchObject({ status: "error", packagePath: candidatePath, version: "1.1.0" });
    expect(registry.update).not.toHaveBeenCalled();
    expect(fixture.loader.unloadSingle).toHaveBeenCalledOnce();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(0);
    expect(fixture.outcomes).toEqual(["review_required"]);
  });

  it("restores the old package after an entered activation when the database cannot have changed", async () => {
    const fixture = setup({ currentPath: candidatePath });
    fixture.packageOperations.seed(makeUpgradeOperation("activation_entered", false));

    await fixture.lifecycle.recoverPackageOperations();

    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: oldPath, version: "1.0.0" });
    expect(registry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({ packagePath: oldPath }));
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.outcomes).toEqual(["rolled_back"]);
  });

  it("keeps the operation pending when the current package matches neither snapshot nor candidate", async () => {
    const changedPath = "C:\\plugins\\example-unrelated";
    const fixture = setup({ currentPath: changedPath });
    fixture.packageOperations.seed(makeUpgradeOperation("committed", false));

    await fixture.lifecycle.recoverPackageOperations();

    expect(currentPlugin).toMatchObject({ status: "error", packagePath: changedPath });
    expect(registry.update).not.toHaveBeenCalled();
    expect(fixture.loader.unloadSingle).not.toHaveBeenCalled();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(1);
    expect(fixture.outcomes).toEqual([]);
  });

  it("keeps the journal pending when worker closure cannot be confirmed", async () => {
    const fixture = setup({ currentPath: candidatePath, workerOpen: true, closeWorker: false });
    fixture.packageOperations.seed(makeUpgradeOperation("committed", false));

    await fixture.lifecycle.recoverPackageOperations();

    expect(fixture.workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(fixture.loader.unloadSingle).not.toHaveBeenCalled();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(1);
    expect(fixture.outcomes).toEqual([]);
  });

  it("keeps the candidate errored and closes its runtime when success completion response is lost", async () => {
    const fixture = setup({ loseSuccessfulCompleteResponse: true });

    await expect(fixture.lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("database response lost after completion");

    expect(currentPlugin).toMatchObject({ status: "error", packagePath: candidatePath, version: "1.1.0" });
    expect(registry.update).toHaveBeenCalledOnce();
    expect(fixture.workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(fixture.loader.unloadSingle).toHaveBeenCalledTimes(2);
    expect(fixture.events.filter(event => event.startsWith("activation:"))).toEqual([`activation:${candidatePath}`]);
    expect(fixture.outcomes).toEqual(["succeeded"]);
    expect(fixture.pending.size).toBe(0);
  });

  it("rejects uninstall of a pending upgrade outside its operation context", async () => {
    const fixture = setup({ currentPath: candidatePath });
    fixture.packageOperations.seed(makeUpgradeOperation("committed", false));

    await expect(fixture.lifecycle.unload(pluginId, true)).rejects.toThrow("Recover the interrupted update");
    await expect(fixture.packageOperations.assertClear(pluginId)).rejects.toThrow("package recovery is pending");

    expect(fixture.loader.unloadSingle).not.toHaveBeenCalled();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(1);
  });

  it("quarantines the restored old package when rollback completion response is lost", async () => {
    const fixture = setup({ loseRollbackCompleteResponse: true });
    fixture.workerManager.setActivationResults([
      { success: false, error: "candidate activation failed" },
      { success: true },
    ]);

    await expect(fixture.lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("rollback completion response lost");

    expect(currentPlugin).toMatchObject({ status: "error", packagePath: oldPath, version: "1.0.0" });
    expect(registry.update).toHaveBeenCalledTimes(2);
    expect(fixture.events.filter(event => event.startsWith("activation:"))).toEqual([
      `activation:${candidatePath}`,
      `activation:${oldPath}`,
    ]);
    expect(fixture.workerManager.stopWorker).toHaveBeenCalledWith(pluginId);
    expect(fixture.loader.unloadSingle).toHaveBeenCalledTimes(3);
    expect(fixture.pending.size).toBe(1);
    expect(fixture.outcomes).toEqual([]);
  });

  it("restores the original status for a rollback_required record even when database changes were possible", async () => {
    const fixture = setup({ currentPath: oldPath });
    fixture.packageOperations.seed(makeUpgradeOperation("rollback_required", true));

    await fixture.lifecycle.recoverPackageOperations();

    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: oldPath, version: "1.0.0" });
    expect(registry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({ packagePath: oldPath, version: "1.0.0" }));
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(0);
    expect(fixture.outcomes).toEqual(["rolled_back"]);
  });

  it("does not restore or reactivate the old package when rollback_required persistence fails", async () => {
    const fixture = setup({ failAdvance: "rollback_required" });
    fixture.workerManager.setActivationResults([{ success: false, error: "candidate activation failed" }]);

    await expect(fixture.lifecycle.upgrade(pluginId, "1.1.0")).rejects.toThrow("phase persistence failed: rollback_required");

    expect(currentPlugin).toMatchObject({ status: "error", packagePath: candidatePath, version: "1.1.0" });
    expect(registry.update).toHaveBeenCalledOnce();
    expect(fixture.events.filter(event => event.startsWith("activation:"))).toEqual([`activation:${candidatePath}`]);
    expect(fixture.loader.unloadSingle).toHaveBeenCalledTimes(2);
    expect(fixture.pending.size).toBe(1);
    expect(fixture.outcomes).toEqual([]);
  });

  it("does nothing when the listed upgrade intent was completed before recovery acquired its fence", async () => {
    const fixture = setup({ currentPath: candidatePath, clearAfterList: true });
    fixture.packageOperations.seed(makeUpgradeOperation("committed", true));
    const initialRow = { ...currentPlugin };

    await fixture.lifecycle.recoverPackageOperations();

    expect(currentPlugin).toEqual(initialRow);
    expect(registry.update).not.toHaveBeenCalled();
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(fixture.loader.unloadSingle).not.toHaveBeenCalled();
    expect(fixture.loader.loadSingle).not.toHaveBeenCalled();
    expect(fixture.pending.size).toBe(0);
    expect(fixture.outcomes).toEqual([]);
  });
});
