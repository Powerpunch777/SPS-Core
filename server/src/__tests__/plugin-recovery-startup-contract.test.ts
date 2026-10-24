import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    bundleCalls: [] as Array<{
      paths: readonly string[];
      dependencies: unknown;
      options?: { installMissing?: boolean };
    }>,
    registry: {
      getByKey: vi.fn(),
      getById: vi.fn(),
    },
    loader: {
      installPlugin: vi.fn(),
      loadAll: vi.fn(),
    },
    lifecycle: {
      attachRuntimeLoader: vi.fn(),
      load: vi.fn(),
    },
    eventBus: {
      observe: vi.fn((_observer: (event: unknown) => unknown) => undefined),
    },
    scheduler: {
      start: vi.fn(() => calls.push("scheduler-start")),
    },
    coordinator: {
      start: vi.fn(() => calls.push("coordinator-start")),
    },
    toolDispatcher: {
      initialize: vi.fn(async () => { calls.push("tools-initialize"); }),
      replaceDynamicTools: vi.fn(),
    },
    watcher: {
      watch: vi.fn(() => calls.push("watch")),
      close: vi.fn(),
    },
    memoryRuntime: {
      handleEvent: vi.fn(),
    },
  };
});

vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "C:/sps/plugins",
  pluginLoader: vi.fn(() => mocks.loader),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => mocks.registry),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: vi.fn(() => mocks.lifecycle),
}));

vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: vi.fn(() => mocks.eventBus),
}));

vi.mock("../services/activity-log.js", () => ({
  setPluginEventBus: vi.fn(),
}));

vi.mock("../services/plugin-job-store.js", () => ({
  pluginJobStore: vi.fn(() => ({})),
}));

vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: vi.fn(() => mocks.scheduler),
}));

vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: vi.fn(() => mocks.coordinator),
}));

vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: vi.fn(() => mocks.toolDispatcher),
}));

vi.mock("../services/memory-provider-runtime.js", () => ({
  createCompanyMemoryProviderRuntime: vi.fn(() => mocks.memoryRuntime),
}));

vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: vi.fn(() => mocks.watcher),
}));

vi.mock("../services/bundled-plugin-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/bundled-plugin-bootstrap.js")>();
  return {
    ...actual,
    installConfiguredBundledPlugins: vi.fn((_paths, _dependencies, options) => {
      mocks.bundleCalls.push({ paths: [..._paths], dependencies: _dependencies, options });
      mocks.calls.push(options?.installMissing === false ? "bundle-refresh" : "bundle-install");
      return Promise.resolve();
    }),
  };
});

vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: vi.fn(() => ({
    disposeAll: vi.fn(),
    teardown: vi.fn(),
  })),
}));

vi.mock("../services/plugin-canonical-diagnostics.js", () => ({
  createPluginCanonicalDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
}));

const envKeys = [
  "SPS_PLUGIN_RECOVERY_MODE",
  "SPS_BUNDLED_PLUGIN_PATHS",
  "PAPERCLIP_BUNDLED_PLUGIN_PATHS",
  "SPS_BUNDLED_PLUGIN_REFRESH_PATHS",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function setRecoveryEnvironment(mode: string | undefined) {
  if (mode === undefined) delete process.env.SPS_PLUGIN_RECOVERY_MODE;
  else process.env.SPS_PLUGIN_RECOVERY_MODE = mode;
  process.env.SPS_BUNDLED_PLUGIN_PATHS = ["C:/bundle/workflow", "C:/bundle/optional"].join(path.delimiter);
  process.env.SPS_BUNDLED_PLUGIN_REFRESH_PATHS = "C:/bundle/refresh";
}

async function createTestApp() {
  return createApp({} as never, {
    uiMode: "none",
    serverPort: 3100,
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: ["localhost"],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: false,
    pluginWorkerManager: {} as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.bundleCalls.length = 0;
  mocks.registry.getByKey.mockResolvedValue({
    id: "kubernetes-plugin-id",
    pluginKey: "paperclip.kubernetes-sandbox-provider",
    status: "ready",
    packagePath: "C:/plugins/kubernetes",
    version: "1.0.0",
  });
  mocks.loader.loadAll.mockImplementation(async () => {
    mocks.calls.push("load-all");
    return {
      results: [{
        success: true,
        plugin: { id: "loaded-plugin-id", packagePath: "C:/plugins/loaded" },
      }],
    };
  });
});

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("createApp plugin recovery startup contract", () => {
  it("suppresses bundle install/refresh/load and every plugin runtime startup effect in all-disabled mode", async () => {
    setRecoveryEnvironment("all-disabled");

    const app = await createTestApp();

    expect(mocks.registry.getByKey).not.toHaveBeenCalled();
    expect(mocks.loader.installPlugin).not.toHaveBeenCalled();
    expect(mocks.loader.loadAll).not.toHaveBeenCalled();
    expect(mocks.bundleCalls).toEqual([]);
    expect(mocks.calls).toEqual([]);
    expect(mocks.scheduler.start).not.toHaveBeenCalled();
    expect(mocks.coordinator.start).not.toHaveBeenCalled();
    expect(mocks.toolDispatcher.initialize).not.toHaveBeenCalled();
    expect(mocks.eventBus.observe).not.toHaveBeenCalled();
    expect(mocks.watcher.watch).not.toHaveBeenCalled();

    app.locals.paperclipShutdown();
    expect(mocks.watcher.close).not.toHaveBeenCalled();
  });

  it("retains the normal bundled install/refresh/load, scheduler, tools, memory subscription, and watcher path", async () => {
    setRecoveryEnvironment(undefined);

    const app = await createTestApp();

    expect(mocks.scheduler.start).toHaveBeenCalledOnce();
    expect(mocks.coordinator.start).toHaveBeenCalledOnce();
    expect(mocks.toolDispatcher.initialize).toHaveBeenCalledOnce();
    expect(mocks.eventBus.observe).toHaveBeenCalledOnce();
    const memoryObserver = mocks.eventBus.observe.mock.calls[0]![0];
    const event = { eventType: "agent.updated" };
    await memoryObserver(event);
    expect(mocks.memoryRuntime.handleEvent).toHaveBeenCalledWith(event);
    await vi.waitFor(() => expect(mocks.calls).toEqual([
      "coordinator-start",
      "scheduler-start",
      "tools-initialize",
      "bundle-install",
      "bundle-refresh",
      "load-all",
      "watch",
    ]));
    expect(mocks.registry.getByKey).toHaveBeenCalledWith("paperclip.kubernetes-sandbox-provider");
    expect(mocks.bundleCalls.map(({ paths, options }) => ({ paths, options }))).toEqual([
      { paths: ["C:/bundle/workflow", "C:/bundle/optional"], options: undefined },
      { paths: ["C:/bundle/refresh"], options: { installMissing: false } },
    ]);
    expect(mocks.bundleCalls.map(({ dependencies }) => dependencies)).toEqual([
      expect.objectContaining({ loader: mocks.loader, lifecycle: mocks.lifecycle, pluginRegistry: mocks.registry }),
      expect.objectContaining({ loader: mocks.loader, lifecycle: mocks.lifecycle, pluginRegistry: mocks.registry }),
    ]);
    expect(mocks.watcher.watch).toHaveBeenCalledWith("loaded-plugin-id", "C:/plugins/loaded");

    app.locals.paperclipShutdown();
    expect(mocks.watcher.close).toHaveBeenCalledOnce();
  });
});
