import { describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ getById: vi.fn(), updateStatus: vi.fn(), update: vi.fn() }));
const fork = vi.hoisted(() => vi.fn(() => { throw new Error("Unexpected worker spawn during package mutation"); }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), fork,
}));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => registry }));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginLoader } from "../services/plugin-loader.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Plugin lifecycle with actual manager start admission", () => {
  it.each(["upgrade", "disable"] as const)("preserves documented state-only %s without runtime services", async operationKind => {
    vi.clearAllMocks();
    const manifest = { id: "example.metadata-only", version: "1.0.0", apiVersion: 1, capabilities: [] };
    const candidate = { ...manifest, version: "1.1.0" };
    let current = { id: "metadata-only", pluginKey: manifest.id, version: "1.0.0", status: "ready", manifestJson: manifest };
    registry.getById.mockImplementation(async () => current);
    registry.updateStatus.mockImplementation(async (_id, input) => { current = { ...current, ...input }; return current; });
    const loader = {
      hasRuntimeServices: () => false,
      loadSingle: vi.fn(), unloadSingle: vi.fn(),
      prepareUpgrade: vi.fn(async () => ({ oldManifest: manifest, newManifest: candidate,
        discovered: { version: "1.1.0", packagePath: "C:\\metadata-candidate", manifest: candidate } })),
      commitPreparedUpgrade: vi.fn(async () => { current = { ...current, version: "1.1.0", manifestJson: candidate }; }),
    };
    const lifecycle = pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader });
    if (operationKind === "upgrade") await lifecycle.upgrade(current.id);
    else await lifecycle.disable(current.id);
    expect(current.status).toBe(operationKind === "upgrade" ? "ready" : "disabled");
    expect(current.version).toBe(operationKind === "upgrade" ? "1.1.0" : "1.0.0");
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it("refuses runtime-backed metadata changes when its process manager is absent", async () => {
    vi.clearAllMocks();
    registry.getById.mockResolvedValue({ id: "missing-owner", pluginKey: "example.missing-owner", status: "ready" });
    const loader = { hasRuntimeServices: () => true, unloadSingle: vi.fn() };
    const lifecycle = pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader });
    await expect(lifecycle.disable("missing-owner")).rejects.toMatchObject({ code: "plugin_package_maintenance_required" });
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(registry.updateStatus).not.toHaveBeenCalled();
  });

  it.each(["upgrade", "disable"] as const)("fences Host starts until %s metadata commits and releases before activation", async operationKind => {
    vi.clearAllMocks();
    const pluginId = "plugin-fenced";
    const oldManifest = { id: "example.fenced", version: "1.0.0", apiVersion: 1, capabilities: [] };
    const newManifest = { ...oldManifest, version: "1.1.0" };
    let current = {
      id: pluginId, pluginKey: oldManifest.id, packageName: "@example/fenced", packagePath: "C:\\old-package",
      version: "1.0.0", manifestJson: oldManifest, status: "ready", lastError: null,
    };
    const commitStarted = deferred(), finishCommit = deferred();
    const manager = createPluginWorkerManager();
    registry.getById.mockImplementation(async () => current);
    registry.updateStatus.mockImplementation(async (_id, input) => {
      if (operationKind === "disable") { commitStarted.resolve(); await finishCommit.promise; }
      current = { ...current, ...input };
      return current;
    });
    const loader = {
      hasRuntimeServices: () => true,
      unloadSingle: vi.fn(async () => {}),
      prepareUpgrade: vi.fn(async () => ({
        oldManifest, newManifest,
        discovered: { packageName: current.packageName, packagePath: "C:\\candidate-package", version: "1.1.0", manifest: newManifest },
      })),
      commitPreparedUpgrade: vi.fn(async () => {
        commitStarted.resolve();
        await finishCommit.promise;
        current = { ...current, version: "1.1.0", packagePath: "C:\\candidate-package", manifestJson: newManifest };
      }),
      loadSingle: vi.fn(async () => {
        // Re-entering the real manager fence would reject if activation were
        // incorrectly attempted while its own package mutation is still held.
        await manager.withPluginPackageMutation!(pluginId, async () => {});
        return { success: true, plugin: current, registered: {} };
      }),
    };
    const lifecycle = pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader, workerManager: manager });
    const operation = operationKind === "upgrade" ? lifecycle.upgrade(pluginId) : lifecycle.disable(pluginId);
    void operation.catch(() => {});
    try {
      await commitStarted.promise;
      await expect(manager.startWorker(pluginId, {} as never)).rejects.toMatchObject({ code: "plugin_package_maintenance_required" });
      expect(fork).not.toHaveBeenCalled();
      expect(current).toMatchObject({ status: "ready", version: "1.0.0", packagePath: "C:\\old-package" });
      finishCommit.resolve();
      await operation;
      expect(current.status).toBe(operationKind === "upgrade" ? "ready" : "disabled");
      expect(loader.loadSingle).toHaveBeenCalledTimes(operationKind === "upgrade" ? 1 : 0);
      expect(current.packagePath).toBe(operationKind === "upgrade" ? "C:\\candidate-package" : "C:\\old-package");
      expect(fork).not.toHaveBeenCalled();
    } finally {
      finishCommit.resolve();
      await operation.catch(() => {});
      await manager.shutdown();
    }
  });
});
