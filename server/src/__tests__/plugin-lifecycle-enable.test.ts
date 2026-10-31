import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginLoader } from "../services/plugin-loader.js";

const pluginId = "plugin-1";
const pluginKey = "example.plugin";
const manifest = { id: pluginKey, version: "1.0.0", capabilities: [] };

let currentPlugin: Record<string, unknown>;

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

function resetRegistry(status: string) {
  currentPlugin = {
    id: pluginId,
    pluginKey,
    status,
    lastError: status === "error" ? "previous activation failed" : null,
    packageName: "@example/plugin",
    packagePath: "C:\\plugins\\example",
    version: "1.0.0",
    manifestJson: manifest,
  };
  registry.getById.mockImplementation(async () => currentPlugin);
  registry.updateStatus.mockImplementation(async (_id: string, input: { status: string; lastError?: string | null }) => {
    currentPlugin = { ...currentPlugin, status: input.status, lastError: input.lastError ?? null };
    return currentPlugin;
  });
}

function setup(status: string, options: {
  packageOperations?: { assertClear: ReturnType<typeof vi.fn> };
  workspaceRuntime?: { withPluginMutation: ReturnType<typeof vi.fn> };
} = {}) {
  resetRegistry(status);
  const loader = {
    hasRuntimeServices: vi.fn(() => true),
    loadSingle: vi.fn(async () => ({
      success: true,
      plugin: currentPlugin,
      registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
    })),
  } as unknown as PluginLoader;
  const workerManager = {
    getWorker: vi.fn(() => undefined),
    stopWorker: vi.fn(async () => undefined),
    withPluginPackageMutation: vi.fn(async (_id: string, action: () => Promise<unknown>) => action()),
  };
  const lifecycle = pluginLifecycleManager({} as never, {
    loader,
    workerManager: workerManager as never,
    ...(options.packageOperations ? { packageOperations: options.packageOperations as never } : {}),
    ...(options.workspaceRuntime ? {
      workspaceRuntime: {
        withPluginMutation: options.workspaceRuntime.withPluginMutation,
        reconcileCatalogPolicy: vi.fn(async () => undefined),
      } as never,
    } : {}),
  });
  return { lifecycle, loader, workerManager };
}

describe("pluginLifecycleManager.enable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["installed", "disabled", "error"])("explicitly activates a %s plugin", async status => {
    const { lifecycle, loader } = setup(status);

    const result = await lifecycle.enable(pluginId);

    expect(result.status).toBe("ready");
    expect(currentPlugin).toMatchObject({ status: "ready", packagePath: "C:\\plugins\\example", manifestJson: manifest });
    expect(registry.updateStatus).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledOnce();
    expect(loader.loadSingle).toHaveBeenCalledWith(pluginId);
  });

  it("rejects upgrade_pending without changing metadata or activating it", async () => {
    const { lifecycle, loader } = setup("upgrade_pending");
    const before = { ...currentPlugin };

    await expect(lifecycle.enable(pluginId)).rejects.toThrow(/waiting for review/i);

    expect(currentPlugin).toEqual(before);
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });

  it.each(["ready", "uninstalled"])("rejects %s without changing metadata or activating it", async status => {
    const { lifecycle, loader } = setup(status);
    const before = { ...currentPlugin };

    await expect(lifecycle.enable(pluginId)).rejects.toThrow(`Cannot enable plugin in status '${status}'.`);

    expect(currentPlugin).toEqual(before);
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });

  it("blocks an installed plugin while its package journal is pending", async () => {
    const assertClear = vi.fn(async () => { throw new Error("package recovery is pending"); });
    const { lifecycle, loader } = setup("installed", { packageOperations: { assertClear } });
    const before = { ...currentPlugin };

    await expect(lifecycle.enable(pluginId)).rejects.toThrow("package recovery is pending");

    expect(assertClear).toHaveBeenCalledWith(pluginId);
    expect(currentPlugin).toEqual(before);
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });

  it("does not activate an installed plugin while Workspace cleanup is unconfirmed", async () => {
    const withPluginMutation = vi.fn(async () => {
      throw Object.assign(new Error("owned closure unconfirmed"), {
        code: "SPS_PLUGIN_RUNTIME_CLEANUP_PENDING",
        operationStarted: false,
      });
    });
    const { lifecycle, loader } = setup("installed", { workspaceRuntime: { withPluginMutation } });
    const before = { ...currentPlugin };

    await expect(lifecycle.enable(pluginId)).rejects.toMatchObject({
      code: "SPS_PLUGIN_RUNTIME_CLEANUP_PENDING",
      operationStarted: false,
    });

    expect(withPluginMutation).toHaveBeenCalledOnce();
    expect(currentPlugin).toEqual(before);
    expect(registry.updateStatus).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
  });
});
