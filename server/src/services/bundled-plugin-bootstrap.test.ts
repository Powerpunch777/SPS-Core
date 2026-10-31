import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installConfiguredBundledPlugins } from "./bundled-plugin-bootstrap.js";

const temporaryRoots: string[] = [];

function bundledPluginDirectory(declaredId: string | null = "sps.test") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sps-bundled-plugin-"));
  temporaryRoots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "sps-test-plugin",
    ...(declaredId === null ? {} : { spsPlugin: { id: declaredId } }),
  })}\n`);
  return root;
}

function dependencies(existing: unknown, manifestId = "sps.test") {
  const loader = {
    installPlugin: vi.fn().mockResolvedValue({ manifest: { id: manifestId, version: "2.0.0" } }),
    loadManifest: vi.fn().mockResolvedValue({ id: manifestId, version: "2.0.0" }),
  };
  const lifecycle = { load: vi.fn().mockResolvedValue(undefined) };
  const pluginRegistry = {
    getByKey: vi.fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ id: "plugin-id", pluginKey: "sps.test", status: "installed", version: "2.0.0", packagePath: null }),
    listByStatus: vi.fn().mockResolvedValue([]),
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

  it.each([true, false])("requires new Host review for a restored pathless record when installMissing=%s", async (installMissing) => {
    const deps = dependencies({
      id: "plugin-id",
      pluginKey: "sps.test",
      status: "uninstalled",
      version: "1.0.0",
      packagePath: null,
    });

    await installConfiguredBundledPlugins([bundledPluginDirectory()], deps, { installMissing });

    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.pluginRegistry.uninstall).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("skips legacy bundles with unknown identity while pathless restored records await review", async () => {
    const deps = dependencies(null);
    deps.pluginRegistry.listByStatus.mockImplementation(async status => status === "uninstalled" ? [{
      id: "restored-plugin",
      pluginKey: "sps.unknown",
      status: "uninstalled",
      packagePath: null,
    }] : []);

    await installConfiguredBundledPlugins([bundledPluginDirectory(null)], deps);

    expect(deps.pluginRegistry.listByStatus).toHaveBeenCalledWith("uninstalled");
    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("does not resurrect a soft-uninstalled record that retains its former path", async () => {
    const packagePath = bundledPluginDirectory();
    const deps = dependencies({
      id: "plugin-id",
      pluginKey: "sps.test",
      status: "uninstalled",
      version: "1.0.0",
      packagePath: path.join(packagePath, "reviewed-stage"),
    });

    await installConfiguredBundledPlugins([packagePath], deps, { installMissing: false });

    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.pluginRegistry.uninstall).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("rejects an invalid declarative identity before importing the manifest", async () => {
    const deps = dependencies(null);

    await installConfiguredBundledPlugins([bundledPluginDirectory("Invalid ID")], deps);

    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("rejects a runtime manifest that disagrees with the declarative identity", async () => {
    const deps = dependencies(null, "sps.other");

    await installConfiguredBundledPlugins([bundledPluginDirectory()], deps);

    expect(deps.loader.loadManifest).toHaveBeenCalledTimes(1);
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
    expect(deps.pluginRegistry.uninstall).not.toHaveBeenCalled();
  });

  it.each(["disabled", "uninstalled", "upgrade_pending"])("does not execute a bundle that the Host left in %s state", async status => {
    const packagePath = bundledPluginDirectory();
    const deps = dependencies({ id: "plugin-id", pluginKey: "sps.test", status,
      version: "1.0.0", packagePath });
    await installConfiguredBundledPlugins([packagePath], deps, { installMissing: false });
    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.pluginRegistry.uninstall).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it.each(["disabled", "uninstalled", "upgrade_pending"])("does not import an unknown legacy bundle while a %s record is inactive", async status => {
    const deps = dependencies(null);
    deps.pluginRegistry.listByStatus.mockImplementation(async queriedStatus => queriedStatus === status
      ? [{ id: "inactive-id", pluginKey: "sps.unknown", status, packagePath: "former-bundle" }]
      : []);
    await installConfiguredBundledPlugins([bundledPluginDirectory(null)], deps);
    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.loader.installPlugin).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();
  });

  it("does not evaluate a real bundled manifest until the preserved record is reinstalled", async () => {
    const pluginPath = bundledPluginDirectory();
    const marker = path.join(pluginPath, "manifest-import.marker");
    const entry = path.join(pluginPath, "manifest.mjs");
    fs.writeFileSync(entry, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\nexport default { id: "sps.test", version: "2.0.0" };\n`);
    const restored = {
      id: "plugin-id", pluginKey: "sps.test", status: "uninstalled", version: "1.0.0",
      packagePath: null as string | null,
    };
    const deps = dependencies(restored);
    deps.loader.loadManifest.mockImplementation(async () => (await import(pathToFileURL(entry).href)).default);

    await installConfiguredBundledPlugins([pluginPath], deps);
    expect(fs.existsSync(marker)).toBe(false);
    expect(deps.loader.loadManifest).not.toHaveBeenCalled();
    expect(deps.lifecycle.load).not.toHaveBeenCalled();

    // The existing Host review/install route records this transition; this
    // test exercises the later startup behavior, not the approval UI itself.
    restored.status = "installed";
    restored.packagePath = pluginPath;
    deps.pluginRegistry.getByKey.mockResolvedValue(restored);
    await installConfiguredBundledPlugins([pluginPath], deps, { installMissing: false });

    expect(fs.readFileSync(marker, "utf8")).toBe("imported");
    expect(deps.lifecycle.load).toHaveBeenCalledWith("plugin-id");
  });
});
