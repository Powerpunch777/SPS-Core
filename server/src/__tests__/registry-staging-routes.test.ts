import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateRegistryCapabilitiesDigest } from "../services/registry-static-manifest.js";

const mockRegistry = vi.hoisted(() => ({
  getByKey: vi.fn(),
  getById: vi.fn(),
}));
const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  enable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const cleanup: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStagedPackage(root: string): Promise<string> {
  const packageRoot = path.join(root, "incoming", "weather-1.2.3");
  const runtimeSource = "export default {};";
  const capabilities = ["agent.tools.register"];
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
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

async function createApp(stagingRoot: string, loader: Record<string, unknown>) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "owner-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes({} as never, loader as never, undefined, undefined, undefined, undefined, undefined, {
    stagingRoot,
  }));
  app.use(errorHandler);
  return app;
}

describe("Registry staging routes", () => {
  it("keeps a static-only stage out of the Plugin registry until explicit Owner enable", async () => {
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "registry-route-stage-"));
    cleanup.push(stagingRoot);
    const packageRoot = await createStagedPackage(stagingRoot);
    const loader = {
      previewRegistryPluginEnable: vi.fn().mockResolvedValue(undefined),
      installPlugin: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(stagingRoot, loader);

    const staged = await request(app)
      .post("/api/plugins/registry/stages")
      .send({
        packageRoot,
        artifactSha256: "a".repeat(64),
        source: { registryId: "io.sps.example", kind: "local", releaseLocator: "releases/weather-1.2.3.json" },
      })
      .expect(201);

    expect(staged.body.status).toBe("staged");
    expect(staged.body.packageRoot).toBeUndefined();
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
    expect(loader.previewRegistryPluginEnable).not.toHaveBeenCalled();

    const installed = { id: "11111111-1111-4111-8111-111111111111", pluginKey: "com.example.weather", status: "installed" };
    const ready = { ...installed, status: "ready", version: "1.2.3" };
    mockRegistry.getByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(installed);
    mockLifecycle.load.mockResolvedValue(ready);

    const enabled = await request(app)
      .post(`/api/plugins/registry/stages/${staged.body.stageId}/enable`)
      .expect(200);

    expect(loader.previewRegistryPluginEnable).toHaveBeenCalledWith(expect.objectContaining({ localPath: packageRoot }));
    expect(loader.installPlugin).toHaveBeenCalledWith(expect.objectContaining({
      localPath: packageRoot,
      skipLocalAutobuild: true,
    }));
    expect(mockLifecycle.load).toHaveBeenCalledWith(installed.id);
    expect(enabled.body.stage.status).toBe("registered");
    expect(enabled.body.plugin.status).toBe("ready");
  });
});
