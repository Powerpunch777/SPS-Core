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
  upgrade: vi.fn(),
}));
const mockInspectMigrations = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));
vi.mock("../services/plugin-database.js", () => ({
  pluginDatabaseService: () => ({ inspectMigrations: mockInspectMigrations }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const cleanup: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStagedPackage(
  root: string,
  version = "1.2.3",
  capabilities = ["agent.tools.register"],
): Promise<string> {
  const packageRoot = path.join(root, "incoming", `weather-${version}`);
  const runtimeSource = "export default {};";
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@example/weather", version }), "utf8");
  await writeFile(path.join(packageRoot, "sps-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    plugin: { id: "com.example.weather", version, apiVersion: "1" },
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

  it("uses the reviewed staged package as an explicit lifecycle upgrade", async () => {
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "registry-route-upgrade-"));
    cleanup.push(stagingRoot);
    const packageRoot = await createStagedPackage(stagingRoot, "1.3.0");
    const loader = {
      previewRegistryPluginEnable: vi.fn().mockResolvedValue(undefined),
      installPlugin: vi.fn().mockResolvedValue(undefined),
      upgradePlugin: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(stagingRoot, loader);

    const staged = await request(app)
      .post("/api/plugins/registry/stages")
      .send({
        packageRoot,
        artifactSha256: "b".repeat(64),
        source: { registryId: "io.sps.example", kind: "local", releaseLocator: "releases/weather-1.3.0.json" },
      })
      .expect(201);

    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: "com.example.weather",
      status: "ready",
      version: "1.2.3",
    };
    const upgraded = { ...existing, version: "1.3.0", status: "ready" };
    mockRegistry.getByKey.mockResolvedValue(existing);
    mockLifecycle.upgrade.mockResolvedValue(upgraded);

    const enabled = await request(app)
      .post(`/api/plugins/registry/stages/${staged.body.stageId}/enable`)
      .expect(200);

    expect(loader.installPlugin).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      localPath: packageRoot,
      skipLocalAutobuild: true,
    }));
    expect(enabled.body.stage.status).toBe("registered");
    expect(enabled.body.plugin.version).toBe("1.3.0");
  });

  it("updates a disabled plugin through the same reviewed lifecycle path", async () => {
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "registry-route-disabled-"));
    cleanup.push(stagingRoot);
    const packageRoot = await createStagedPackage(stagingRoot, "1.4.0");
    const loader = {
      previewRegistryPluginEnable: vi.fn().mockResolvedValue(undefined),
      installPlugin: vi.fn().mockResolvedValue(undefined),
      upgradePlugin: vi.fn().mockResolvedValue(undefined),
    };
    const app = await createApp(stagingRoot, loader);

    const staged = await request(app)
      .post("/api/plugins/registry/stages")
      .send({
        packageRoot,
        artifactSha256: "c".repeat(64),
        source: { registryId: "io.sps.example", kind: "local", releaseLocator: "releases/weather-1.4.0.json" },
      })
      .expect(201);

    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: "com.example.weather",
      status: "disabled",
      version: "1.3.0",
    };
    const enabledPlugin = { ...existing, version: "1.4.0", status: "ready" };
    mockRegistry.getByKey.mockResolvedValue(existing);
    mockLifecycle.upgrade.mockResolvedValue(enabledPlugin);

    await request(app)
      .post(`/api/plugins/registry/stages/${staged.body.stageId}/enable`)
      .expect(200);

    expect(loader.installPlugin).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(existing.id, expect.objectContaining({
      localPath: packageRoot,
      skipLocalAutobuild: true,
    }));
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
  });

  it("pins a high-risk Registry candidate until the Host approves that stage", async () => {
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "registry-route-review-"));
    cleanup.push(stagingRoot);
    const packageRoot = await createStagedPackage(stagingRoot, "1.5.0", ["agent.tools.register", "secrets.read"]);
    const loader = {
      previewRegistryPluginEnable: vi.fn().mockResolvedValue({
        manifest: {
          id: "com.example.weather",
          version: "1.5.0",
          capabilities: ["agent.tools.register", "secrets.read"],
          database: { migrationsDir: "migrations" },
        },
      }),
    };
    const app = await createApp(stagingRoot, loader);

    const staged = await request(app)
      .post("/api/plugins/registry/stages")
      .send({
        packageRoot,
        artifactSha256: "d".repeat(64),
        source: { registryId: "io.sps.example", kind: "official", releaseLocator: "releases/weather-1.5.0.json" },
      })
      .expect(201);

    const existing = {
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: "com.example.weather",
      status: "ready",
      version: "1.4.0",
      manifestJson: { capabilities: ["agent.tools.register"] },
    };
    mockRegistry.getByKey.mockResolvedValue(existing);
    mockRegistry.getById.mockResolvedValue(existing);
    mockLifecycle.upgrade
      .mockResolvedValueOnce({ ...existing, status: "upgrade_pending" })
      .mockResolvedValueOnce({ ...existing, version: "1.5.0", status: "ready" });
    mockInspectMigrations.mockResolvedValue({
      pluginId: existing.id,
      pluginKey: existing.pluginKey,
      targetVersion: "1.5.0",
      namespaceName: "plugin_example",
      hasAppliedMigrations: true,
      requiresHostApproval: true,
      reviewHash: "plan-1",
      pendingMigrations: [],
    });

    const response = await request(app)
      .post(`/api/plugins/registry/stages/${staged.body.stageId}/enable`)
      .expect(200);

    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(existing.id, expect.not.objectContaining({
      approvedCapabilityEscalation: true,
    }));
    expect(response.body.stage.status).toBe("review_pending");
    expect(response.body.stage.review).toMatchObject({
      pluginRecordId: existing.id,
      targetVersion: "1.5.0",
      addedCapabilities: ["secrets.read"],
      migrationPlan: { reviewHash: "plan-1" },
    });

    const pending = await request(app)
      .get(`/api/plugins/${existing.id}/pending-update`)
      .expect(200);
    expect(pending.body).toMatchObject({
      stageId: staged.body.stageId,
      targetVersion: "1.5.0",
      addedCapabilities: ["secrets.read"],
    });

    await request(app)
      .post(`/api/plugins/${existing.id}/upgrade`)
      .send({
        stageId: staged.body.stageId,
        approvedCapabilityEscalation: true,
        approvedDataMigrationPlanHash: "plan-1",
      })
      .expect(200);

    expect(mockLifecycle.upgrade).toHaveBeenLastCalledWith(existing.id, expect.objectContaining({
      localPath: packageRoot,
      registryStaticManifest: expect.any(Object),
      approvedCapabilityEscalation: true,
      approvedDataMigrationPlanHash: "plan-1",
    }));
    const stages = await request(app).get("/api/plugins/registry/stages").expect(200);
    expect(stages.body[0].status).toBe("registered");
  });
});
