import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  assertPluginPackageMutationPermit,
  withPluginPackageMutationPermit,
  type PluginPackageMutationPermit,
} from "../services/sps-plugin-package-maintenance.js";
import type {
  SpsPluginPackageOperation,
  SpsPluginPackageOperations,
} from "../services/sps-plugin-package-operations.js";

const initialPlugin = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "disabled",
  packageName: "@example/plugin",
  packagePath: "C:\\plugins\\example",
  version: "1.0.0",
  manifestJson: { id: "example.plugin", capabilities: [] },
} as const;

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  updateStatus: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

function createStore() {
  const pending = new Map<string, SpsPluginPackageOperation>();
  let failBegin = false;
  const operations: SpsPluginPackageOperations = {
    async beginUninstall(snapshot, removeData) {
      if (failBegin) throw new Error("intent persistence failed");
      const operation: SpsPluginPackageOperation = {
        id: "operation-1",
        pluginId: snapshot.id,
        pluginKey: snapshot.pluginKey,
        kind: "uninstall",
        snapshot,
        removeData,
      };
      pending.set(snapshot.id, operation);
      return operation;
    },
    async pendingForPlugin(pluginId) {
      return pending.get(pluginId) ?? null;
    },
    async listPending() {
      return [...pending.values()];
    },
    async assertClear(pluginId) {
      if (pluginId && pending.has(pluginId)) throw new Error("package recovery is pending");
    },
    async complete(operationId) {
      const entry = [...pending.entries()].find(([, operation]) => operation.id === operationId);
      if (entry) pending.delete(entry[0]);
    },
  };
  return {
    operations,
    pending,
    failIntentPersistence() { failBegin = true; },
    seed(snapshot = initialPlugin, removeData = false) {
      const operation: SpsPluginPackageOperation = {
        id: "operation-1",
        pluginId: snapshot.id,
        pluginKey: snapshot.pluginKey,
        kind: "uninstall",
        snapshot: snapshot as never,
        removeData,
      };
      pending.set(snapshot.id, operation);
      return operation;
    },
  };
}

function setup(options: {
  store?: ReturnType<typeof createStore>;
  current?: Record<string, unknown> | null;
  byKey?: Record<string, unknown> | null;
  workerOpen?: boolean;
  closeWorker?: boolean;
  cleanupFails?: boolean;
} = {}) {
  const events: string[] = [];
  const store = options.store ?? createStore();
  let current: Record<string, unknown> | null = options.current === undefined
    ? { ...initialPlugin }
    : options.current;
  let byKey: Record<string, unknown> | null = options.byKey ?? null;
  let worker: object | undefined = options.workerOpen ? {} : undefined;

  registry.getById.mockImplementation(async () => current);
  registry.getByKey.mockImplementation(async () => byKey);
  registry.updateStatus.mockImplementation(async (_id, update) => {
    if (!current) return null;
    current = { ...current, ...update };
    return current;
  });
  registry.uninstall.mockImplementation(async (id: string, removeData: boolean) => {
    if (removeData) current = null;
    else if (current) current = { ...current, status: "uninstalled" };
    return current;
  });

  const loader = {
    hasRuntimeServices: () => true,
    unloadSingle: vi.fn(async () => { events.push("unload"); }),
    cleanupInstallArtifacts: vi.fn(async (plugin: typeof initialPlugin, permit: PluginPackageMutationPermit) => {
      assertPluginPackageMutationPermit(permit, plugin.id, false);
      events.push("cleanup");
      if (options.cleanupFails) throw new Error("artifact cleanup failed");
    }),
    requiresSharedPluginArtifactCleanup: () => false,
    discoverAll: vi.fn(async () => []),
  } as unknown as PluginLoader;
  const workerManager = {
    getWorker: vi.fn(() => worker),
    isRunning: vi.fn(() => Boolean(worker)),
    stopWorker: vi.fn(async () => {
      events.push("stop");
      if (options.closeWorker !== false) worker = undefined;
    }),
    withPluginPackageMutation: vi.fn(async (id: string, action: (permit: PluginPackageMutationPermit) => Promise<unknown>) => {
      events.push("private-fence");
      return withPluginPackageMutationPermit(id, false, action);
    }),
    withExclusivePackageMutation: vi.fn(async (id: string, action: (permit: PluginPackageMutationPermit) => Promise<unknown>) => {
      events.push("exclusive-fence");
      return withPluginPackageMutationPermit(id, true, action);
    }),
    withPluginWorkerStartFence: vi.fn(async (_id: string, action: () => Promise<unknown>) => action()),
  } as unknown as PluginWorkerManager;

  const lifecycle = () => pluginLifecycleManager({} as never, {
    loader,
    workerManager,
    packageOperations: store.operations,
  });
  return {
    store,
    lifecycle,
    loader,
    workerManager,
    events,
    current: () => current,
    setCurrent(value: Record<string, unknown> | null) { current = value; },
    setByKey(value: Record<string, unknown> | null) { byKey = value; },
  };
}

describe("plugin lifecycle durable package removal recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not clean artifacts or uninstall when intent persistence fails", async () => {
    const fixture = setup();
    fixture.store.failIntentPersistence();

    await expect(fixture.lifecycle().unload(initialPlugin.id, true)).rejects.toThrow("intent persistence failed");

    expect(fixture.loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(registry.uninstall).not.toHaveBeenCalled();
    expect(fixture.store.pending.size).toBe(0);
  });

  it("keeps the durable intent when artifact cleanup fails", async () => {
    const fixture = setup({ cleanupFails: true });

    await expect(fixture.lifecycle().unload(initialPlugin.id)).rejects.toThrow("artifact cleanup failed");

    expect(fixture.store.pending.size).toBe(1);
    expect(registry.uninstall).not.toHaveBeenCalled();
  });

  it("resumes the same pending removal with a fresh lifecycle and the current error row", async () => {
    const store = createStore();
    store.seed(initialPlugin, false);
    const fixture = setup({ store, current: { ...initialPlugin, status: "error" } });

    await fixture.lifecycle().recoverPackageOperations();

    expect(fixture.loader.cleanupInstallArtifacts).toHaveBeenCalledOnce();
    expect(registry.uninstall).toHaveBeenCalledWith(initialPlugin.id, false);
    expect(store.pending.size).toBe(0);
  });

  it("repeats cleanup and completes after a hard-delete response is lost", async () => {
    const store = createStore();
    const first = setup({ store });
    registry.uninstall.mockImplementationOnce(async () => {
      first.setCurrent(null);
      throw new Error("database response lost after commit");
    });

    await expect(first.lifecycle().unload(initialPlugin.id, true)).rejects.toThrow("database response lost after commit");
    expect(store.pending.size).toBe(1);

    const resumed = setup({ store, current: null, byKey: null });
    await resumed.lifecycle().recoverPackageOperations();

    expect(resumed.loader.cleanupInstallArtifacts).toHaveBeenCalledOnce();
    expect(registry.getByKey).toHaveBeenCalledWith(initialPlugin.pluginKey);
    expect(registry.uninstall).toHaveBeenCalledOnce();
    expect(store.pending.size).toBe(0);
  });

  it.each([
    ["a replacement plugin ID", null, { ...initialPlugin, id: "plugin-2" }],
    ["a changed package path", { ...initialPlugin, packagePath: "C:\\plugins\\replacement" }, null],
  ] as const)("preserves artifacts when recovery finds %s", async (_description, current, byKey) => {
    const store = createStore();
    store.seed(initialPlugin, true);
    const fixture = setup({ store, current, byKey });

    await fixture.lifecycle().recoverPackageOperations();

    expect(fixture.loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(store.pending.size).toBe(1);
  });

  it("does not complete a removal while the exact worker handle remains open", async () => {
    const store = createStore();
    store.seed(initialPlugin, false);
    const fixture = setup({ store, workerOpen: true, closeWorker: false });

    await fixture.lifecycle().recoverPackageOperations();

    expect(fixture.workerManager.stopWorker).toHaveBeenCalled();
    expect(fixture.loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(registry.uninstall).not.toHaveBeenCalled();
    expect(store.pending.size).toBe(1);
  });

  it.each([
    ["enable", (lifecycle: ReturnType<ReturnType<typeof setup>["lifecycle"]>) => lifecycle.enable(initialPlugin.id)],
    ["upgrade", (lifecycle: ReturnType<ReturnType<typeof setup>["lifecycle"]>) => lifecycle.upgrade(initialPlugin.id)],
    ["startWorker", (lifecycle: ReturnType<ReturnType<typeof setup>["lifecycle"]>) => lifecycle.startWorker(initialPlugin.id, {} as never)],
  ])("blocks %s while a package operation is pending", async (_name, invoke) => {
    const fixture = setup();
    fixture.store.seed(initialPlugin);

    await expect(invoke(fixture.lifecycle())).rejects.toThrow("package recovery is pending");

    expect(fixture.loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(registry.uninstall).not.toHaveBeenCalled();
  });

  it("rejects retry when removeData would strengthen the persisted policy", async () => {
    const fixture = setup();
    fixture.store.seed(initialPlugin, false);

    await expect(fixture.lifecycle().unload(initialPlugin.id, true)).rejects.toThrow("Resume the existing package removal");

    expect(fixture.loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(fixture.store.pending.size).toBe(1);
  });
});
