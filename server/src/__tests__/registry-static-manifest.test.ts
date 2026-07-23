import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  assertRegistryRuntimeManifestMatchesStatic,
  calculateRegistryCapabilitiesDigest,
  parseRegistryStaticPluginManifest,
} from "../services/registry-static-manifest.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runtimeManifest(): PaperclipPluginManifestV1 {
  return {
    id: "com.example.weather",
    apiVersion: 1,
    version: "1.2.3",
    displayName: "Weather",
    description: "Example",
    author: "Example",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
  };
}

describe("Registry static plugin manifest", () => {
  it("matches a reviewed declaration to the enabled runtime manifest", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "registry-static-"));
    cleanup.push(packageRoot);
    const manifestPath = path.join(packageRoot, "dist", "manifest.js");
    const source = "export default {};";
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, source, "utf8");
    const capabilities = ["agent.tools.register"];
    const reviewed = parseRegistryStaticPluginManifest({
      schemaVersion: 1,
      plugin: { id: "com.example.weather", version: "1.2.3", apiVersion: "1" },
      runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(source).digest("hex") },
      capabilities,
      permissionsDigest: calculateRegistryCapabilitiesDigest(capabilities),
    });

    await expect(assertRegistryRuntimeManifestMatchesStatic({
      packageRoot,
      manifestPath,
      staticManifest: reviewed,
      runtimeManifest: runtimeManifest(),
    })).resolves.toBeUndefined();
  });

  it("rejects a runtime manifest that expands reviewed capabilities", async () => {
    const source = "export default {};";
    const reviewed = parseRegistryStaticPluginManifest({
      schemaVersion: 1,
      plugin: { id: "com.example.weather", version: "1.2.3", apiVersion: "1" },
      runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(source).digest("hex") },
      capabilities: ["agent.tools.register"],
      permissionsDigest: calculateRegistryCapabilitiesDigest(["agent.tools.register"]),
    });
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "registry-static-"));
    cleanup.push(packageRoot);
    const manifestPath = path.join(packageRoot, "dist", "manifest.js");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, source, "utf8");

    await expect(assertRegistryRuntimeManifestMatchesStatic({
      packageRoot,
      manifestPath,
      staticManifest: reviewed,
      runtimeManifest: { ...runtimeManifest(), capabilities: ["agent.tools.register", "http.outbound"] },
    })).rejects.toThrow("Runtime manifest identity or capabilities do not match");
  });
});
