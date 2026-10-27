import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpsNativePluginUiAssetService } from "./sps-native-plugin-ui-assets.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sps-native-plugin-ui-assets-"));
  roots.push(root);
  const packageRoot = path.join(root, "plugin");
  const uiRoot = path.join(packageRoot, "dist", "ui");
  await mkdir(path.join(uiRoot, "assets"), { recursive: true });
  const plugin = {
    packageName: "@sps/plugin-fixture",
    packagePath: packageRoot,
    manifestJson: { entrypoints: { ui: "./dist/ui/" } },
  } as never;
  return { root, packageRoot, uiRoot, plugin, service: createSpsNativePluginUiAssetService({ localPluginDir: root }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("SPS Native Plugin UI asset reader", () => {
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
