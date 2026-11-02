import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  assertPluginPackageMutationPermit,
  withPluginPackageMutationPermit,
  type PluginPackageMutationPermit,
} from "../services/sps-plugin-package-maintenance.js";

const plugin = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "disabled",
  packageName: "@example/plugin",
  packagePath: "C:\\plugins\\example",
  version: "1.0.0",
  manifestJson: { id: "example.plugin", capabilities: [] },
};

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

describe("plugin lifecycle package cleanup fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.getById.mockResolvedValue(plugin);
    registry.uninstall.mockResolvedValue(null);
  });

  function setup(shared: boolean, confirmClose = true) {
    const events: string[] = [];
    let targetHandle: object | undefined = {};
    const workerManager = {
      getWorker: vi.fn(() => targetHandle),
      isRunning: vi.fn(() => Boolean(targetHandle)),
      stopWorker: vi.fn(async () => {
        events.push("stop");
        if (confirmClose) targetHandle = undefined;
      }),
      withPluginPackageMutation: vi.fn(async (id: string, action: (permit: PluginPackageMutationPermit) => Promise<unknown>) => {
        events.push("private-fence");
        return withPluginPackageMutationPermit(id, false, action);
      }),
      withExclusivePackageMutation: vi.fn(async (id: string, action: (permit: PluginPackageMutationPermit) => Promise<unknown>) => {
        events.push("exclusive-fence");
        return withPluginPackageMutationPermit(id, true, action);
      }),
    } as unknown as PluginWorkerManager;
    const loader = {
      hasRuntimeServices: () => true,
      unloadSingle: vi.fn(async () => { events.push("unload"); }),
      cleanupInstallArtifacts: vi.fn(async (_plugin: typeof plugin, permit: PluginPackageMutationPermit) => {
        assertPluginPackageMutationPermit(permit, plugin.id, shared);
        events.push("cleanup");
      }),
      requiresSharedPluginArtifactCleanup: () => shared,
    } as unknown as PluginLoader;
    const lifecycle = pluginLifecycleManager({} as never, { loader, workerManager });
    return { lifecycle, loader, workerManager, events };
  }

  it.each([
    [false, "private-fence"],
    [true, "exclusive-fence"],
  ] as const)("uses %s package classification to select the cleanup fence", async (shared, expectedFence) => {
    const { lifecycle, loader, workerManager, events } = setup(shared);
    await lifecycle.unload(plugin.id);
    expect(shared ? workerManager.withExclusivePackageMutation : workerManager.withPluginPackageMutation)
      .toHaveBeenCalledOnce();
    expect(events).toEqual([expectedFence, "unload", "stop", "cleanup"]);
    expect(registry.uninstall).toHaveBeenCalledOnce();
  });

  it("does not remove artifacts or registry data when worker close is unconfirmed", async () => {
    const { lifecycle, loader } = setup(false, false);
    await expect(lifecycle.unload(plugin.id)).rejects.toMatchObject({
      code: "plugin_package_maintenance_required",
    });
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(registry.uninstall).not.toHaveBeenCalled();
  });
});
