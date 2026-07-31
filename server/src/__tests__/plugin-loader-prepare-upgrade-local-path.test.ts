import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginId = "0b4a8a32-7bb8-4c24-a3fe-22e9f451cb04";
const pluginKey = "sps.prepare-upgrade-local-path";
const activePackagePath = "C:\\active\\prepare-upgrade-plugin";

const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  listInstalled: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLoader } from "../services/plugin-loader.js";

const activeManifest = {
  id: pluginKey,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Prepare Upgrade Fixture",
  description: "A local-path upgrade regression fixture.",
  author: "SPS",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "./dist/worker.js" },
};

async function createCandidatePackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const packageRoot = path.join(root, name);
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: `@sps/${name}`,
      version: "1.1.0",
      type: "module",
      spsPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
      },
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "dist", "manifest.js"),
    `export default ${JSON.stringify(manifest, null, 2)};\n`,
    "utf8",
  );
  await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n", "utf8");
  await writeFile(path.join(packageRoot, "candidate-marker.txt"), `${name}-source`, "utf8");
  return packageRoot;
}

describe("pluginLoader.prepareUpgrade local-path staging", () => {
  const cleanupPaths = new Set<string>();
  let currentPlugin: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentPlugin = {
      id: pluginId,
      pluginKey,
      packageName: "@sps/prepare-upgrade-active",
      packagePath: activePackagePath,
      version: activeManifest.version,
      manifestJson: activeManifest,
    };
    registry.getById.mockImplementation(async () => currentPlugin);
    registry.listInstalled.mockResolvedValue([currentPlugin]);
  });

  afterEach(async () => {
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it("stages local candidates under a UUID path while preserving the source and active package on validation failure or success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sps-plugin-loader-upgrade-"));
    cleanupPaths.add(root);
    const localPluginDir = path.join(root, "managed-plugins");
    const activePackage = path.join(root, "active-package");
    await mkdir(activePackage, { recursive: true });
    await writeFile(path.join(activePackage, "active-marker.txt"), "active-package-content", "utf8");
    currentPlugin.packagePath = activePackage;

    const invalidCandidate = await createCandidatePackage(root, "invalid-candidate", {
      ...activeManifest,
      id: "sps.wrong-plugin-id",
      version: "1.1.0",
    });
    const validCandidate = await createCandidatePackage(root, "valid-candidate", {
      ...activeManifest,
      version: "1.1.0",
    });
    const loader = pluginLoader({} as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.prepareUpgrade(pluginId, { localPath: invalidCandidate })).rejects.toThrow(
      "does not match existing plugin ID",
    );
    expect(await readFile(path.join(activePackage, "active-marker.txt"), "utf8")).toBe("active-package-content");
    expect(await readFile(path.join(invalidCandidate, "candidate-marker.txt"), "utf8")).toBe("invalid-candidate-source");
    expect(currentPlugin.packagePath).toBe(activePackage);
    expect(registry.getById).toHaveBeenCalledWith(pluginId);
    expect(
      await readdir(path.join(localPluginDir, ".upgrade-staging", pluginId)).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      }),
    ).toEqual([]);

    const prepared = await loader.prepareUpgrade(pluginId, { localPath: validCandidate });
    const stagedPath = prepared.discovered.packagePath;
    const stagedRelativePath = path.relative(localPluginDir, stagedPath).replace(/\\/g, "/");

    expect(stagedRelativePath).toMatch(new RegExp(
      `^\\.upgrade-staging/${pluginId}/[0-9a-f-]{36}/package$`,
      "i",
    ));
    expect(stagedPath).not.toBe(validCandidate);
    expect(await readFile(path.join(stagedPath, "candidate-marker.txt"), "utf8")).toBe("valid-candidate-source");
    expect(await readFile(path.join(activePackage, "active-marker.txt"), "utf8")).toBe("active-package-content");
    expect(await readFile(path.join(validCandidate, "candidate-marker.txt"), "utf8")).toBe("valid-candidate-source");
    expect(currentPlugin.packagePath).toBe(activePackage);
    expect(registry.getById).toHaveBeenCalledWith(pluginId);
  });
});
