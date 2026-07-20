import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConfiguredBundledPlugins, parseBundledPluginPaths } from "../services/bundled-plugin-bootstrap.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("parseBundledPluginPaths", () => {
  it("deduplicates and trims paths using the host delimiter", () => {
    expect(parseBundledPluginPaths(" /plugins/rooms : /plugins/rooms : /plugins/memory ", ":"))
      .toEqual(["/plugins/rooms", "/plugins/memory"]);
  });
});

describe("installConfiguredBundledPlugins", () => {
  it("installs and activates an explicit local bundle once", async () => {
    const pluginPath = path.join(os.tmpdir(), `sps-bundled-plugin-${crypto.randomUUID()}`);
    temporaryPaths.push(pluginPath);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "package.json"), "{}", "utf8");

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
      pluginRegistry: { getByKey, uninstall: vi.fn() },
    });

    expect(installPlugin).toHaveBeenCalledWith({ localPath: path.resolve(pluginPath) });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not replace an installed bundle when its path and version still match", async () => {
    const pluginPath = path.join(os.tmpdir(), `sps-bundled-plugin-${crypto.randomUUID()}`);
    temporaryPaths.push(pluginPath);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "package.json"), "{}", "utf8");

    const installPlugin = vi.fn();
    const lifecycleLoad = vi.fn();
    const uninstall = vi.fn();
    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest: async () => ({ id: "local.room-chat", version: "0.3.60" }), installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginRegistry: {
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
    const pluginPath = path.join(os.tmpdir(), `sps-bundled-plugin-${crypto.randomUUID()}`);
    temporaryPaths.push(pluginPath);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "package.json"), "{}", "utf8");

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
      pluginRegistry: { getByKey, uninstall },
    });

    expect(uninstall).toHaveBeenCalledWith("plugin-1", false);
    expect(installPlugin).toHaveBeenCalledWith({ localPath: path.resolve(pluginPath) });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
  });

  it("retries the same bundle after a previous activation error", async () => {
    const pluginPath = path.join(os.tmpdir(), `sps-bundled-plugin-${crypto.randomUUID()}`);
    temporaryPaths.push(pluginPath);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "package.json"), "{}", "utf8");

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
      pluginRegistry: { getByKey, uninstall },
    });

    expect(uninstall).toHaveBeenCalledWith("plugin-1", false);
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
  });
});
