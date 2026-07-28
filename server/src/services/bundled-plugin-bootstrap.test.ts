import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConfiguredBundledPlugins } from "./bundled-plugin-bootstrap.js";

const temporaryRoots: string[] = [];

function bundledPluginDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sps-bundled-plugin-"));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"sps-test-plugin"}\n');
  return root;
}

function dependencies(existing: unknown) {
  const loader = {
    installPlugin: vi.fn().mockResolvedValue({ manifest: { id: "sps.test", version: "2.0.0" } }),
    loadManifest: vi.fn().mockResolvedValue({ id: "sps.test", version: "2.0.0" }),
  };
  const lifecycle = { load: vi.fn().mockResolvedValue(undefined) };
  const pluginRegistry = {
    getByKey: vi.fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ id: "plugin-id", pluginKey: "sps.test", status: "installed", version: "2.0.0", packagePath: null }),
    uninstall: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return { loader, lifecycle, pluginRegistry, logger };
}

afterEach(() => {
  while (temporaryRoots.length) fs.rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("configured bundled plugin refresh", () => {
  it("does not install an optional plugin that the Owner has not selected", async () => {
    const deps = dependencies(null);
    await installConfiguredBundledPlugins([bundledPluginDirectory()], deps, { installMissing: false });

    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
    expect(deps.pluginRegistry.uninstall).not.toHaveBeenCalled();
  });

  it("refreshes an already installed plugin from the current Desktop bundle", async () => {
    const packagePath = bundledPluginDirectory();
    const deps = dependencies({
      id: "plugin-id",
      pluginKey: "sps.test",
      status: "ready",
      version: "1.0.0",
      packagePath: path.join(packagePath, "previous"),
    });

    await installConfiguredBundledPlugins([packagePath], deps, { installMissing: false });

    expect(deps.pluginRegistry.uninstall).toHaveBeenCalledWith("plugin-id", false);
    expect(deps.loader.installPlugin).toHaveBeenCalledWith({ localPath: packagePath });
    expect(deps.lifecycle.load).toHaveBeenCalledWith("plugin-id");
  });
});
