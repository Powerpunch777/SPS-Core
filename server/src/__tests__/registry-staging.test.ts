import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { calculateRegistryCapabilitiesDigest } from "../services/registry-static-manifest.js";
import { registryStagingService } from "../services/registry-staging.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStagedPackage(root: string): Promise<string> {
  const packageRoot = path.join(root, "packages", "weather-1.2.3");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  const runtimeSource = "export default {};";
  const capabilities = ["agent.tools.register"];
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@example/weather", version: "1.2.3" }), "utf8");
  await writeFile(path.join(packageRoot, "sps-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    plugin: { id: "com.example.weather", version: "1.2.3", apiVersion: "1" },
    runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(runtimeSource).digest("hex") },
    capabilities,
    permissionsDigest: calculateRegistryCapabilitiesDigest(capabilities),
  }), "utf8");
  await writeFile(path.join(packageRoot, "dist", "manifest.js"), runtimeSource, "utf8");
  return packageRoot;
}

describe("Registry staging service", () => {
  it("persists a static-only staged package inside the Owner Host staging root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "registry-staging-"));
    cleanup.push(root);
    const packageRoot = await createStagedPackage(root);
    const service = registryStagingService(root);

    const record = await service.stage({
      packageRoot,
      artifactSha256: "a".repeat(64),
      source: { registryId: "io.sps.example", kind: "local", releaseLocator: "releases/weather-1.2.3.json" },
    });

    expect(record.status).toBe("staged");
    expect(record.pluginId).toBe("com.example.weather");
    expect(await service.get(record.stageId)).toMatchObject({ packageName: "@example/weather", status: "staged" });
    expect(await service.list()).toHaveLength(1);

    await expect(service.markRegistered(record.stageId)).resolves.toMatchObject({ status: "registered" });
    await expect(service.get(record.stageId)).resolves.toMatchObject({ status: "registered" });
  });

  it("refuses a package path outside the managed staging root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "registry-staging-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "registry-outside-"));
    cleanup.push(root, outside);
    const packageRoot = await createStagedPackage(outside);

    await expect(registryStagingService(root).stage({
      packageRoot,
      artifactSha256: "a".repeat(64),
      source: { registryId: "io.sps.example", kind: "local", releaseLocator: "releases/weather-1.2.3.json" },
    })).rejects.toThrow("managed staging root");
  });
});
