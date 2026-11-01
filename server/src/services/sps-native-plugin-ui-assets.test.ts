import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpsNativePluginUiAssetService } from "./sps-native-plugin-ui-assets.js";

type UiPlugin = Parameters<ReturnType<typeof createSpsNativePluginUiAssetService>["read"]>[0];
const roots: Array<{ root: string; parent: string; identity: BigIntStats; sentinel: string }> = [];

async function fixture() {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "sps-native-plugin-ui-assets-"));
  const identity = await lstat(root, { bigint: true });
  const sentinel = path.join(root, "external-keep.txt");
  await writeFile(sentinel, "synthetic external bytes must stay");
  roots.push({ root, parent, identity, sentinel });
  const packageRoot = path.join(root, "plugin");
  const uiRoot = path.join(packageRoot, "dist", "ui");
  await mkdir(path.join(uiRoot, "assets"), { recursive: true });
  const plugin = {
    packageName: "@sps/plugin-fixture",
    packagePath: packageRoot,
    manifestJson: { entrypoints: { ui: "./dist/ui/" } },
  } as unknown as UiPlugin;
  return { root, packageRoot, uiRoot, plugin, service: createSpsNativePluginUiAssetService({ localPluginDir: root }) };
}

afterEach(async () => {
  for (const owned of roots.splice(0)) {
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.parent
      && path.basename(owned.root).startsWith("sps-native-plugin-ui-assets-")).toBe(true);
    expect(await realpath(owned.root)).toBe(owned.root);
    const current = await lstat(owned.root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(current[key]).toBe(owned.identity[key]);
    expect(await readFile(owned.sentinel, "utf8")).toBe("synthetic external bytes must stay");
    await rm(owned.root, { recursive: true, force: false });
  }
});

async function legacyFixture() {
  const value = await fixture();
  const installedRoot = path.join(value.root, "node_modules", "@sps", "plugin-fixture");
  const directRoot = path.join(value.root, "@sps", "plugin-fixture");
  for (const [root, label] of [[installedRoot, "installed"], [directRoot, "direct"]] as const) {
    const ui = path.join(root, "dist", "ui");
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, "index.js"), `export const source = '${label}';\n`);
    await writeFile(path.join(ui, `${label}.css`), "body { color: black; }\n");
  }
  return { ...value, installedRoot, directRoot };
}

describe("SPS Native Plugin UI asset reader", () => {
  it.each([
    ["empty", ""], ["whitespace", " \t\n "], ["zero", 0], ["false", false],
    ["object", {}], ["array", []], ["boxed string", new String("ignored")],
  ])("rejects explicit %s packagePath while both real legacy packages exist", async (_label, packagePath) => {
    const { plugin, service, installedRoot, directRoot } = await legacyFixture();
    expect((await lstat(installedRoot)).isDirectory()).toBe(true);
    expect((await lstat(directRoot)).isDirectory()).toBe(true);
    const invalid = { ...plugin, packagePath } as UiPlugin;
    await expect(service.read(invalid, "index.js")).rejects.toThrow("unavailable");
    await expect(service.listCss(invalid)).rejects.toThrow("unavailable");
  });

  it("rejects a relative explicit path even when it resolves to an existing UI package", async () => {
    const { plugin, service, packageRoot, uiRoot } = await legacyFixture();
    await writeFile(path.join(uiRoot, "index.js"), "export const source = 'relative';\n");
    let relative = path.relative(process.cwd(), packageRoot);
    if (process.platform === "win32" && path.isAbsolute(relative)) {
      // TEMP may be on another drive than the checkout. A drive-relative
      // spelling still resolves to this owned fixture without changing cwd.
      const drive = path.parse(packageRoot).root.slice(0, 2);
      relative = drive + path.relative(path.resolve(drive), packageRoot);
    }
    expect(path.isAbsolute(relative)).toBe(false);
    expect(await realpath(path.resolve(relative))).toBe(packageRoot);
    const invalid = { ...plugin, packagePath: relative };
    await expect(service.read(invalid, "index.js")).rejects.toThrow("unavailable");
    await expect(service.listCss(invalid)).rejects.toThrow("unavailable");
  });

  it("never falls back from a missing explicit absolute root to either existing legacy package", async () => {
    const { root, plugin, service, installedRoot, directRoot } = await legacyFixture();
    expect((await lstat(installedRoot)).isDirectory()).toBe(true);
    expect((await lstat(directRoot)).isDirectory()).toBe(true);
    const invalid = { ...plugin, packagePath: path.join(root, "missing-explicit") };
    await expect(service.read(invalid, "index.js")).rejects.toThrow("unavailable");
    await expect(service.listCss(invalid)).rejects.toThrow("unavailable");
  });

  it.each([null, undefined])("preserves legacy precedence and direct fallback for packagePath %s", async packagePath => {
    const { plugin, service, installedRoot } = await legacyFixture();
    const legacy = { ...plugin, packagePath } as UiPlugin;
    const installed = await service.read(legacy, "index.js");
    expect(Buffer.from(installed.bytes, "base64url").toString("utf8")).toContain("'installed'");
    await expect(service.listCss(legacy)).resolves.toEqual(["installed.css"]);
    await rename(installedRoot, `${installedRoot}.preserved`);
    const direct = await service.read(legacy, "index.js");
    expect(Buffer.from(direct.bytes, "base64url").toString("utf8")).toContain("'direct'");
    await expect(service.listCss(legacy)).resolves.toEqual(["direct.css"]);
  });

  it.skipIf(process.platform !== "win32")("keeps an existing absolute Windows case alias without choosing a legacy package", async () => {
    const { root, plugin, service, uiRoot } = await legacyFixture();
    await writeFile(path.join(uiRoot, "index.js"), "export const source = 'explicit-alias';\n");
    const aliased = { ...plugin, packagePath: path.join(root, "PlUgIn") };
    const asset = await service.read(aliased, "index.js");
    expect(Buffer.from(asset.bytes, "base64url").toString("utf8")).toContain("'explicit-alias'");
    await expect(service.listCss(aliased)).resolves.toEqual([]);
  });

  it("returns bounded canonical bytes, allowlisted MIME, and a matching digest", async () => {
    const { uiRoot, plugin, service } = await fixture();
    const source = Buffer.from("export const value = 3;\n");
    await writeFile(path.join(uiRoot, "index.js"), source);

    const asset = await service.read(plugin, "index.js");
    expect(asset).toEqual({
      path: "index.js",
      contentType: "text/javascript; charset=utf-8",
      bytes: source.toString("base64url"),
      sha256: createHash("sha256").update(source).digest("hex"),
    });
  });

  it("lists only bounded top-level CSS assets", async () => {
    const { uiRoot, plugin, service } = await fixture();
    await writeFile(path.join(uiRoot, "surface.css"), "body { color: black; }");
    await writeFile(path.join(uiRoot, "assets", "nested.css"), "body { color: red; }");
    await expect(service.listCss(plugin)).resolves.toEqual(["surface.css"]);
  });

  it("bounds UI directory enumeration while collecting CSS metadata", async () => {
    const { uiRoot, plugin, service } = await fixture();
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(path.join(uiRoot, `asset-${index}.js`), "x")));
    await expect(service.listCss(plugin)).rejects.toThrow("unavailable");
  });

  it("rejects traversal, encoded/separator aliases, and unsupported extensions", async () => {
    const { uiRoot, plugin, service } = await fixture();
    await writeFile(path.join(uiRoot, "index.js"), "export {};");
    await writeFile(path.join(uiRoot, "index.html"), "<script></script>");
    for (const candidate of ["../secret.js", "%2e%2e/secret.js", "assets\\file.js", "/index.js", "index.html", "index.js.map"]) {
      await expect(service.read(plugin, candidate)).rejects.toThrow("unavailable");
    }
  });

  it("rejects files larger than four MiB and refuses symlinked assets", async () => {
    const { root, uiRoot, plugin, service } = await fixture();
    await writeFile(path.join(uiRoot, "large.js"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    await expect(service.read(plugin, "large.js")).rejects.toThrow("unavailable");

    const outside = path.join(root, "outside.js");
    const linked = path.join(uiRoot, "linked.js");
    await writeFile(outside, "export {};");
    try { await symlink(outside, linked); }
    catch { return; }
    await expect(service.read(plugin, "linked.js")).rejects.toThrow("unavailable");
  });
});
