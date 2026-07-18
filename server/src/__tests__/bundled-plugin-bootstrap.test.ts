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
      pluginRegistry: { getByKey },
    });

    expect(installPlugin).toHaveBeenCalledWith({ localPath: path.resolve(pluginPath) });
    expect(lifecycleLoad).toHaveBeenCalledWith("plugin-1");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not replace an installed bundle on a later Hub start", async () => {
    const pluginPath = path.join(os.tmpdir(), `sps-bundled-plugin-${crypto.randomUUID()}`);
    temporaryPaths.push(pluginPath);
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "package.json"), "{}", "utf8");

    const installPlugin = vi.fn();
    const lifecycleLoad = vi.fn();
    await installConfiguredBundledPlugins([pluginPath], {
      loader: { loadManifest: async () => ({ id: "local.room-chat" }), installPlugin },
      lifecycle: { load: lifecycleLoad },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginRegistry: { getByKey: async () => ({ id: "plugin-1", pluginKey: "local.room-chat", status: "ready" }) },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(lifecycleLoad).not.toHaveBeenCalled();
  });
});
