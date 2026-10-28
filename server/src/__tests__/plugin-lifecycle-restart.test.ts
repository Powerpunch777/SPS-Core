/**
 * Regression test for PAP-9585.
 *
 * `restartWorker` is called by the dev file-watcher whenever a local-path
 * plugin's source files change. Before PAP-9585 it only bounced the worker
 * subprocess, which left newly added `migrations/*.sql` files unapplied — the
 * plugin schema would silently drift out of sync with worker code.
 *
 * The fix is for `restartWorker` to do a full deactivate + reactivate cycle
 * via the plugin loader, which re-reads the manifest from disk and runs
 * `applyMigrations` (idempotently) before starting the new worker.
 */
import { describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function makeWorkerManagerStub() {
  const handle = {
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    handle,
    workerManager: {
      getWorker: vi.fn().mockReturnValue(handle),
      isRunning: vi.fn().mockReturnValue(true),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      restartWorker: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkerManager,
  };
}

describe("pluginLifecycleManager.restartWorker", () => {
  it("does not reload package code until the Workspace runtime coordinator admits the mutation", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    const { handle, workerManager } = makeWorkerManagerStub();
    const reconcileCatalogPolicy = vi.fn(async () => {});
    const withPluginMutation = vi.fn(async () => { throw new Error("owned closure unconfirmed"); });
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: { hasRuntimeServices: () => false } as PluginLoader,
      workerManager,
      workspaceRuntime: { withPluginMutation, reconcileCatalogPolicy },
    });
    await expect(lifecycle.restartWorker("plugin-1")).rejects.toMatchObject({
      code: "SPS_PLUGIN_RUNTIME_CLEANUP_PENDING", operationStarted: false,
    });
    expect(handle.restart).not.toHaveBeenCalled();
    expect(reconcileCatalogPolicy).not.toHaveBeenCalled();
  });

  it("coordinates non-HTTP reloads and reconciles their policy before returning", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    const { handle, workerManager } = makeWorkerManagerStub();
    const events: string[] = [];
    handle.restart.mockImplementation(async () => { events.push("reload"); });
    const lifecycle = pluginLifecycleManager({} as never, {
      loader: { hasRuntimeServices: () => false } as PluginLoader,
      workerManager,
      workspaceRuntime: {
        withPluginMutation: async (_id, action) => { events.push("drain"); return action(); },
        reconcileCatalogPolicy: async () => { events.push("reconcile"); },
      },
    });
    await lifecycle.restartWorker("plugin-1");
    expect(events).toEqual(["drain", "reload", "reconcile"]);
  });

  it("does a full deactivate+reactivate cycle when the loader has runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: pluginRecord,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    // The bare worker handle should NOT be bounced — the loader handles
    // worker (re)start as part of activate.
    expect(handle.restart).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it("falls back to bouncing the worker handle when the loader has no runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(false) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn() as PluginLoader["loadSingle"],
      unloadSingle: vi.fn() as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(handle.restart).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
  });
});

describe("pluginLifecycleManager.attachRuntimeLoader", () => {
  it("activates a newly installed plugin through the attached runtime loader", async () => {
    const installedPlugin = { ...pluginRecord, status: "installed" };
    const readyPlugin = { ...pluginRecord, status: "ready" };
    mockRegistry.getById.mockResolvedValue(installedPlugin);
    mockRegistry.updateStatus.mockResolvedValue(readyPlugin);

    const { workerManager } = makeWorkerManagerStub();
    const runtimeLoader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: readyPlugin,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
    };
    const lifecycle = pluginLifecycleManager({} as never, { workerManager });

    lifecycle.attachRuntimeLoader(runtimeLoader as PluginLoader);
    await lifecycle.load("plugin-1");

    expect(runtimeLoader.loadSingle).toHaveBeenCalledWith("plugin-1");
    expect(() => lifecycle.attachRuntimeLoader({} as PluginLoader)).toThrow(/already attached/i);
  });
});
