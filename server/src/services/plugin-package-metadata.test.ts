import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { pluginLoader, resolveDeclaredPluginEntrypoints } from "./plugin-loader.js";
import {
  declaredSpsPluginEntrypoint,
  resolveSpsPluginPackageMetadata,
} from "./plugin-package-metadata.js";

const entrypoints = {
  manifest: "./dist/manifest.js",
  worker: "./dist/worker.js",
  ui: "./dist/ui",
};

describe("resolveSpsPluginPackageMetadata", () => {
  it("uses spsPlugin as the primary package contract", () => {
    const resolved = resolveSpsPluginPackageMetadata({ spsPlugin: entrypoints });

    expect(resolved).toEqual({
      entrypoints,
      source: "spsPlugin",
      usesLegacyCompatibilityKey: false,
    });
    expect(declaredSpsPluginEntrypoint({ spsPlugin: entrypoints }, "manifest"))
      .toBe("./dist/manifest.js");
  });

  it("feeds SPS metadata into the plugin loader entrypoint inspection path", () => {
    const packageRoot = path.join("C:", "plugins", "example");

    expect(resolveDeclaredPluginEntrypoints(packageRoot, { spsPlugin: entrypoints })).toEqual([
      { key: "manifest", absolutePath: path.resolve(packageRoot, "./dist/manifest.js") },
      { key: "worker", absolutePath: path.resolve(packageRoot, "./dist/worker.js") },
      { key: "ui", absolutePath: path.resolve(packageRoot, "./dist/ui") },
    ]);
  });

  it("loads a package that only declares spsPlugin", async () => {
    const packageRoot = mkdtempSync(path.join(os.tmpdir(), "sps-plugin-package-"));
    try {
      writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
        name: "@example/sps-plugin",
        type: "module",
        spsPlugin: { manifest: "./manifest.js" },
      }));
      writeFileSync(path.join(packageRoot, "manifest.js"), `export default ${JSON.stringify({
        id: "sps.test-package",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "SPS Test Package",
        description: "Loads through the SPS metadata path.",
        author: "SPS",
        categories: ["automation"],
        capabilities: ["companies.read"],
        entrypoints: { worker: "./worker.js" },
      })};\n`);

      const loader = pluginLoader({} as never, {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      });

      await expect(loader.loadManifest(packageRoot)).resolves.toMatchObject({
        id: "sps.test-package",
      });
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts paperclipPlugin as a compatibility alias", () => {
    const resolved = resolveSpsPluginPackageMetadata({ paperclipPlugin: entrypoints });

    expect(resolved).toEqual({
      entrypoints,
      source: "paperclipPlugin",
      usesLegacyCompatibilityKey: true,
    });
  });

  it("accepts dual metadata only when it is structurally identical", () => {
    const resolved = resolveSpsPluginPackageMetadata({
      spsPlugin: entrypoints,
      paperclipPlugin: { ui: "./dist/ui", worker: "./dist/worker.js", manifest: "./dist/manifest.js" },
    });

    expect(resolved?.source).toBe("spsPlugin");
  });

  it("rejects conflicting dual metadata before a host can choose an entrypoint", () => {
    expect(() => resolveSpsPluginPackageMetadata({
      spsPlugin: entrypoints,
      paperclipPlugin: { ...entrypoints, worker: "./legacy-worker.js" },
    })).toThrow(/ambiguous.*spsPlugin.*paperclipPlugin/i);
  });
});
