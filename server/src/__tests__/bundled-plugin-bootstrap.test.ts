import fs, { type BigIntStats } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConfiguredBundledPlugins, parseBundledPluginPaths } from "../services/bundled-plugin-bootstrap.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";

const temporaryPaths: Array<{ root: string; parent: string; identity: BigIntStats }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const owned of temporaryPaths.splice(0)) {
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.parent
      && path.basename(owned.root).startsWith("sps-bundled-plugin-")).toBe(true);
    expect(await realpath(owned.root)).toBe(owned.root);
    const current = await lstat(owned.root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(current[key]).toBe(owned.identity[key]);
    expect(await readFile(path.join(owned.root, "external-keep.txt"), "utf8")).toBe("preserve synthetic external data");
    await rm(owned.root, { recursive: true, force: false });
  }
});

async function createBundle() {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "sps-bundled-plugin-"));
  temporaryPaths.push({ root, parent, identity: await lstat(root, { bigint: true }) });
  await writeFile(path.join(root, "external-keep.txt"), "preserve synthetic external data");
  await writeFile(path.join(root, "package.json"), "{}", "utf8");
  return root;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function refreshDependencies(pluginPath: string) {
  let current = { id: "plugin-1", pluginKey: "local.room-chat", status: "ready", version: "1.0.0",
    packagePath: path.join(pluginPath, "previous-package") };
  const maintenance = createSpsPluginArtifactMaintenance();
  const loader = {
    loadManifest: vi.fn(async () => ({ id: "local.room-chat", version: "2.0.0" })),
    installPlugin: vi.fn(async () => {
      current = { ...current, packagePath: pluginPath, status: "installed", version: "2.0.0" };
      return { manifest: { id: "local.room-chat", version: "2.0.0" } };
    }),
  };
  const pluginRegistry = {
    getByKey: vi.fn(async () => current), listByStatus: vi.fn(async () => []),
    uninstall: vi.fn(async () => {
      current = { ...current, status: "uninstalled" };
      // Synthetic registry persistence only, not a real Core database integration.
      await writeFile(path.join(pluginPath, "synthetic-registry.json"), JSON.stringify(current));
    }),
  };
  return { artifactMaintenance: maintenance, loader, pluginRegistry,
    lifecycle: { load: vi.fn(async () => { current = { ...current, status: "ready" }; }) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, readCurrent: () => current };
}

describe("parseBundledPluginPaths", () => {
  it("deduplicates and trims paths using the host delimiter", () => {
    expect(parseBundledPluginPaths(" /plugins/rooms : /plugins/rooms : /plugins/memory ", ":"))
      .toEqual(["/plugins/rooms", "/plugins/memory"]);
  });
});

describe("installConfiguredBundledPlugins", () => {
  it("installs and activates an explicit local bundle once", async () => {
    const pluginPath = await createBundle();

    const installed = { id: "plugin-1", pluginKey: "local.room-chat", status: "installed" };
    const loadManifest = vi.fn(async () => ({ id: "local.room-chat" }));
    const installPlugin = vi.fn(async () => ({ manifest: { id: "local.room-chat" } }));
    const getByKey = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(installed);
    const lifecycleLoad = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest, installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger,
      pluginRegistry: { getByKey, listByStatus: async () => [], uninstall: vi.fn() },
    });

    expect(installPlugin).toHaveBeenCalledWith({ localPath: path.resolve(pluginPath) });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not replace an installed bundle when its path and version still match", async () => {
    const pluginPath = await createBundle();

    const installPlugin = vi.fn();
    const lifecycleLoad = vi.fn();
    const uninstall = vi.fn();
    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest: async () => ({ id: "local.room-chat", version: "0.3.60" }), installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginRegistry: {
        listByStatus: async () => [],
        getByKey: async () => ({
          id: "plugin-1",
          pluginKey: "local.room-chat",
          packagePath: pluginPath,
          status: "ready",
          version: "0.3.60",
        }),
        uninstall,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(lifecycleLoad).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("refreshes an installed bundle when the Desktop-provided path or version changes", async () => {
    const pluginPath = await createBundle();

    const refreshed = { id: "plugin-1", pluginKey: "local.room-chat", status: "installed" };
    const uninstall = vi.fn(async () => undefined);
    const installPlugin = vi.fn(async () => ({ manifest: { id: "local.room-chat", version: "0.3.60" } }));
    const lifecycleLoad = vi.fn(async () => undefined);
    const getByKey = vi.fn()
      .mockResolvedValueOnce({
        id: "plugin-1",
        pluginKey: "local.room-chat",
        packagePath: "C:\\old-runtime\\sps-room-chat",
        status: "ready",
        version: "0.3.59",
      })
      .mockResolvedValueOnce(refreshed);

    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest: async () => ({ id: "local.room-chat", version: "0.3.60" }), installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginRegistry: { getByKey, listByStatus: async () => [], uninstall },
    });

    expect(uninstall).toHaveBeenCalledWith("plugin-1", false);
    expect(installPlugin).toHaveBeenCalledWith({ localPath: path.resolve(pluginPath) });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
  });

  it("retries the same bundle after a previous activation error", async () => {
    const pluginPath = await createBundle();

    const refreshed = { id: "plugin-1", pluginKey: "sps.default-memory", status: "installed" };
    const uninstall = vi.fn(async () => undefined);
    const installPlugin = vi.fn(async () => ({ manifest: { id: "sps.default-memory", version: "0.1.0" } }));
    const lifecycleLoad = vi.fn(async () => undefined);
    const getByKey = vi.fn()
      .mockResolvedValueOnce({
        id: "plugin-1",
        pluginKey: "sps.default-memory",
        packagePath: pluginPath,
        status: "error",
        version: "0.1.0",
      })
      .mockResolvedValueOnce(refreshed);

    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest: async () => ({ id: "sps.default-memory", version: "0.1.0" }), installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginRegistry: { getByKey, listByStatus: async () => [], uninstall },
    });

    expect(uninstall).toHaveBeenCalledWith("plugin-1", false);
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
  });

  it("rejects maintenance-busy bootstrap before filesystem IO, imports, lookups or soft-uninstall", async () => {
    const pluginPath = await createBundle();
    const dependencies = refreshDependencies(pluginPath);
    const io = [vi.spyOn(fs, "existsSync"), vi.spyOn(fs, "statSync"), vi.spyOn(fs, "readFileSync")];
    await dependencies.artifactMaintenance.withMaintenance(async () => {
      await expect(installConfiguredBundledPlugins([pluginPath], dependencies)).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      for (const operation of io) expect(operation).not.toHaveBeenCalled();
      expect(dependencies.loader.loadManifest).not.toHaveBeenCalled();
      expect(dependencies.pluginRegistry.getByKey).not.toHaveBeenCalled();
      expect(dependencies.pluginRegistry.listByStatus).not.toHaveBeenCalled();
      expect(dependencies.pluginRegistry.uninstall).not.toHaveBeenCalled();
      expect(dependencies.loader.installPlugin).not.toHaveBeenCalled();
      expect(dependencies.lifecycle.load).not.toHaveBeenCalled();
      expect(dependencies.logger.error).not.toHaveBeenCalled();
    });
    vi.restoreAllMocks();
    expect(dependencies.readCurrent().status).toBe("ready");
    await expect(lstat(path.join(pluginPath, "synthetic-registry.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await installConfiguredBundledPlugins([pluginPath], dependencies);
    expect(dependencies.pluginRegistry.uninstall).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.load).toHaveBeenCalledOnce();
  });

  it("holds admission from the first registry lookup until it settles", async () => {
    const pluginPath = await createBundle();
    const dependencies = refreshDependencies(pluginPath);
    await writeFile(path.join(pluginPath, "package.json"), JSON.stringify({ spsPlugin: { id: "local.room-chat" } }));
    const entered = deferred(), release = deferred();
    const originalLookup = dependencies.pluginRegistry.getByKey.getMockImplementation()!;
    dependencies.pluginRegistry.getByKey.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return originalLookup();
    });
    const bootstrapping = installConfiguredBundledPlugins([pluginPath], dependencies);
    try {
      await entered.promise;
      await expect(dependencies.artifactMaintenance.withMaintenance(async () => undefined)).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      expect(dependencies.loader.loadManifest).not.toHaveBeenCalled();
      expect(dependencies.pluginRegistry.uninstall).not.toHaveBeenCalled();
    } finally { release.resolve(); await bootstrapping; }
    expect(dependencies.lifecycle.load).toHaveBeenCalledOnce();
  });

  it("keeps maintenance out after completed soft-uninstall while installation and final activation are pending", async () => {
    const pluginPath = await createBundle();
    const dependencies = refreshDependencies(pluginPath);
    const installing = deferred(), finishInstall = deferred(), activating = deferred(), finishLoad = deferred();
    const originalInstall = dependencies.loader.installPlugin.getMockImplementation()!;
    const originalLoad = dependencies.lifecycle.load.getMockImplementation()!;
    dependencies.loader.installPlugin.mockImplementationOnce(async () => {
      installing.resolve(); await finishInstall.promise; return originalInstall();
    });
    dependencies.lifecycle.load.mockImplementationOnce(async () => {
      activating.resolve(); await finishLoad.promise; await originalLoad();
    });
    const bootstrapping = installConfiguredBundledPlugins([pluginPath], dependencies);
    try {
      await installing.promise;
      expect(dependencies.pluginRegistry.uninstall).toHaveBeenCalledWith("plugin-1", false);
      expect(JSON.parse(await readFile(path.join(pluginPath, "synthetic-registry.json"), "utf8")).status).toBe("uninstalled");
      await expect(dependencies.artifactMaintenance.withMaintenance(async () => undefined)).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      finishInstall.resolve();
      await activating.promise;
      await expect(dependencies.artifactMaintenance.withMaintenance(async () => undefined)).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    } finally { finishInstall.resolve(); finishLoad.resolve(); await bootstrapping; }
    expect(dependencies.readCurrent().status).toBe("ready");
    expect(dependencies.logger.error).not.toHaveBeenCalled();
    await expect(dependencies.artifactMaintenance.withMaintenance(async () => "available")).resolves.toBe("available");
  });

  it("retains per-bundle failure logging and continuation, then releases the whole invocation", async () => {
    const firstPath = await createBundle();
    const secondPath = await createBundle();
    const dependencies = refreshDependencies(firstPath);
    const failure = new Error("controlled first bundle manifest failure");
    dependencies.loader.loadManifest.mockRejectedValueOnce(failure);
    await expect(installConfiguredBundledPlugins([firstPath, secondPath], dependencies)).resolves.toBeUndefined();
    expect(dependencies.logger.error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, pluginPath: firstPath }, "failed to auto-install configured bundled plugin; continuing Hub startup");
    expect(dependencies.loader.loadManifest).toHaveBeenCalledTimes(2);
    expect(dependencies.loader.installPlugin).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.load).toHaveBeenCalledOnce();
    await expect(dependencies.artifactMaintenance.withMaintenance(async () => "available")).resolves.toBe("available");
  });

  it("logs an installation failure after soft-uninstall without claiming activation or leaking activity", async () => {
    const pluginPath = await createBundle();
    const dependencies = refreshDependencies(pluginPath);
    const failure = new Error("controlled installation failure after soft-uninstall");
    dependencies.loader.installPlugin.mockRejectedValueOnce(failure);
    await expect(installConfiguredBundledPlugins([pluginPath], dependencies)).resolves.toBeUndefined();
    expect(dependencies.pluginRegistry.uninstall).toHaveBeenCalledOnce();
    expect(dependencies.readCurrent().status).toBe("uninstalled");
    expect(dependencies.lifecycle.load).not.toHaveBeenCalled();
    expect(dependencies.logger.error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, pluginPath }, "failed to auto-install configured bundled plugin; continuing Hub startup");
    await expect(dependencies.artifactMaintenance.withMaintenance(async () => "available")).resolves.toBe("available");
  });

  it("releases activity after malformed metadata without importing or claiming a successful load", async () => {
    const pluginPath = await createBundle();
    await writeFile(path.join(pluginPath, "package.json"), "{incomplete");
    const dependencies = refreshDependencies(pluginPath);
    await expect(installConfiguredBundledPlugins([pluginPath], dependencies)).resolves.toBeUndefined();
    expect(dependencies.logger.error).toHaveBeenCalledOnce();
    expect(dependencies.loader.loadManifest).not.toHaveBeenCalled();
    expect(dependencies.pluginRegistry.uninstall).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.load).not.toHaveBeenCalled();
    await expect(dependencies.artifactMaintenance.withMaintenance(async () => "available")).resolves.toBe("available");
    expect(await readFile(path.join(pluginPath, "package.json"), "utf8")).toBe("{incomplete");
  });
});
