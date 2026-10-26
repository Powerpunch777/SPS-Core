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
    workerManager: {
      shutdown: vi.fn(async () => { calls.push("workers-stopped"); }),
    },
    hostCleanup: {
      disposeAll: vi.fn(() => { calls.push("host-services-disposed"); }),
      teardown: vi.fn(),
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
      stop: vi.fn(),
    },
    coordinator: {
      start: vi.fn(() => calls.push("coordinator-start")),
      stop: vi.fn(),
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
  createPluginHostServiceCleanup: vi.fn(() => mocks.hostCleanup),
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
const bundledPaths = ["workflow", "optional"].map(name => path.resolve("fixture-bundle", name));
const bundledRefreshPath = path.resolve("fixture-bundle", "refresh");

function setRecoveryEnvironment(mode: string | undefined) {
  if (mode === undefined) delete process.env.SPS_PLUGIN_RECOVERY_MODE;
  else process.env.SPS_PLUGIN_RECOVERY_MODE = mode;
  process.env.SPS_BUNDLED_PLUGIN_PATHS = bundledPaths.join(path.delimiter);
  process.env.SPS_BUNDLED_PLUGIN_REFRESH_PATHS = bundledRefreshPath;
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
    pluginWorkerManager: mocks.workerManager as never,
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

    await app.locals.paperclipShutdown();
    expect(mocks.watcher.close).not.toHaveBeenCalled();
    expect(mocks.workerManager.shutdown).toHaveBeenCalledOnce();
    expect(mocks.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.coordinator.stop).toHaveBeenCalledOnce();
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
      { paths: bundledPaths, options: undefined },
      { paths: [bundledRefreshPath], options: { installMissing: false } },
    ]);
    expect(mocks.bundleCalls.map(({ dependencies }) => dependencies)).toEqual([
      expect.objectContaining({ loader: mocks.loader, lifecycle: mocks.lifecycle, pluginRegistry: mocks.registry }),
      expect.objectContaining({ loader: mocks.loader, lifecycle: mocks.lifecycle, pluginRegistry: mocks.registry }),
    ]);
    expect(mocks.watcher.watch).toHaveBeenCalledWith("loaded-plugin-id", "C:/plugins/loaded");

    await app.locals.paperclipShutdown();
    expect(mocks.watcher.close).toHaveBeenCalledOnce();
    expect(mocks.workerManager.shutdown).toHaveBeenCalledOnce();
    expect(mocks.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.coordinator.stop).toHaveBeenCalledOnce();
  });

  it("waits for a still-starting plugin and owned workers without watching after shutdown", async () => {
    setRecoveryEnvironment(undefined);
    let releaseStartup!: () => void;
    const startup = new Promise<void>(resolve => { releaseStartup = resolve; });
    mocks.loader.loadAll.mockImplementationOnce(async () => {
      await startup;
      return { results: [{ success: true, plugin: { id: "late-plugin", packagePath: "C:/fixture/late" } }] };
    });
    const app = await createTestApp();
    await vi.waitFor(() => expect(mocks.loader.loadAll).toHaveBeenCalledOnce());
    const stopping = app.locals.paperclipShutdown();
    expect(app.locals.paperclipShutdown()).toBe(stopping);
    expect(mocks.workerManager.shutdown).toHaveBeenCalledOnce();
    let settled = false;
    void stopping.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseStartup();
    await stopping;
    expect(mocks.watcher.watch).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledOnce();
  });

  it("keeps Host services until workers settle and propagates failed shutdown", async () => {
    setRecoveryEnvironment("all-disabled");
    let rejectWorkers!: (error: Error) => void;
    const workers = new Promise<void>((_resolve, reject) => { rejectWorkers = reject; });
    mocks.workerManager.shutdown.mockImplementationOnce(() => workers);
    const app = await createTestApp();
    const stopping = app.locals.paperclipShutdown();
    const failure = expect(stopping).rejects.toThrow("Plugin runtime shutdown failed.");
    expect(app.locals.paperclipShutdown()).toBe(stopping);
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.hostCleanup.disposeAll).not.toHaveBeenCalled();
    rejectWorkers(new Error("fixture process remains"));
    await failure;
    expect(mocks.hostCleanup.disposeAll).toHaveBeenCalledOnce();
    expect(mocks.hostCleanup.teardown).toHaveBeenCalledOnce();
    expect(mocks.workerManager.shutdown).toHaveBeenCalledOnce();
  });
});
