import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginRecoveryState, type PluginRecoveryState } from "../services/sps-plugin-recovery.js";
import { SpsPluginRuntimeCleanupPendingError, withSpsPluginRuntimeMutation } from "../services/sps-plugin-runtime-mutation.js";
import { PluginPackageMaintenanceRequiredError } from "../services/sps-plugin-package-maintenance.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  restartWorker: vi.fn(),
}));

const mockAccess = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
}));

const mockWorkspaceSurfaces = vi.hoisted(() => ({
  deleteInboxSummariesBySourcePluginKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockPublishGlobalLiveEvent = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../services/sps-workspace-surfaces.js", () => ({
  spsWorkspaceSurfaceService: () => mockWorkspaceSurfaces,
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: mockPublishGlobalLiveEvent,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccess,
}));

async function createApp(
  actor: Record<string, unknown>,
  loaderOverrides: Record<string, unknown> = {},
  routeOverrides: {
    db?: unknown;
    jobDeps?: unknown;
    toolDeps?: unknown;
    bridgeDeps?: unknown;
    diagnosticsDeps?: unknown;
    recoveryState?: PluginRecoveryState;
    captureJsonContext?: (context: unknown, body: unknown) => void;
  } = {},
) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const loader = {
    installPlugin: vi.fn(),
    ...loaderOverrides,
  };

  const app = express();
  app.use(express.json());
  if (routeOverrides.captureJsonContext) {
    app.use((_req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        routeOverrides.captureJsonContext?.((res as any).__errorContext, body);
        return originalJson(body);
      }) as typeof res.json;
      next();
    });
  }
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(
    (routeOverrides.db ?? {}) as never,
    loader as never,
    routeOverrides.jobDeps as never,
    undefined,
    routeOverrides.toolDeps as never,
    routeOverrides.bridgeDeps as never,
    undefined,
    undefined,
    undefined,
    routeOverrides.diagnosticsDeps as never,
    routeOverrides.recoveryState,
  ));
  app.use(errorHandler);

  return { app, loader };
}

function createSelectQueueDb(rows: Array<Array<Record<string, unknown>>>) {
  const valuesResult = {
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([])),
    })),
    then: <TResult1 = Array<Record<string, unknown>>, TResult2 = never>(
      onfulfilled?: ((value: Array<Record<string, unknown>>) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve([] as Array<Record<string, unknown>>).then(onfulfilled, onrejected),
  };

  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows.shift() ?? [])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => valuesResult),
    })),
  };
}

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const agentA = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555555";
const projectA = "66666666-6666-4666-8666-666666666666";
const pluginId = "11111111-1111-4111-8111-111111111111";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyA],
    ...overrides,
  };
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: agentA,
    companyId: companyA,
    runId: runA,
    source: "agent_jwt",
    ...overrides,
  };
}

function readyPlugin() {
  const plugin = {
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "@example/paperclip-plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    manifestJson: {
      id: "paperclip.example",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Example Plugin",
      description: "Route authorization fixture.",
      author: "Tests",
      categories: [],
      capabilities: [],
      entrypoints: { worker: "./worker.js" },
      companyActivation: { defaultEnabled: true },
    },
  };
  mockRegistry.getById.mockResolvedValue(plugin);
  mockRegistry.listInstalled.mockResolvedValue([plugin]);
  return plugin;
}

describe.sequential("plugin install and upgrade authz", () => {
  beforeAll(async () => {
    await Promise.all([
      import("../routes/plugins.js"),
      import("../middleware/index.js"),
    ]);
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.canUser.mockResolvedValue(false);
    mockAccess.hasPermission.mockResolvedValue(false);
    mockAccess.getMembership.mockResolvedValue({ status: "active" });
    mockRegistry.listInstalled.mockResolvedValue([]);
    mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey.mockResolvedValue(0);
  });

  it("lists bundled monorepo plugin packages", async () => {
    const { app } = await createApp(boardActor());

    const res = await request(app).get("/api/plugins/examples");

    expect(res.status).toBe(200);
    const packageNames = res.body.map((plugin: { packageName: string }) => plugin.packageName);
    const byPackageName = new Map(
      res.body.map((plugin: { packageName: string; experimental: boolean; hasBuiltEntrypoints: boolean }) => [plugin.packageName, plugin]),
    );
    expect(packageNames).toContain("@paperclipai/plugin-workspace-diff");
    expect(packageNames).toContain("@paperclipai/plugin-llm-wiki");
    expect(packageNames).toContain("@paperclipai/plugin-modal");
    expect(packageNames).toContain("@paperclipai/plugin-authoring-smoke-example");
    expect(packageNames).not.toContain("@paperclipai/plugin-sdk");
    expect(byPackageName.get("@paperclipai/plugin-workspace-diff")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-llm-wiki")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-modal")?.experimental).toBe(true);
    expect(byPackageName.get("@paperclipai/plugin-authoring-smoke-example")?.experimental).toBe(false);
    expect(typeof byPackageName.get("@paperclipai/plugin-workspace-diff")?.hasBuiltEntrypoints).toBe("boolean");
  }, 20_000);

  it("requires Agent configuration permission before exposing company memory controls", async () => {
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .get(`/api/plugins/companies/${companyA}/memory-provider`);

    expect(res.status).toBe(403);
    expect(mockAccess.hasPermission).toHaveBeenCalledWith(companyA, "user", "user-1", "agents:configure");
  });

  it("allows an instance admin through the memory-control authorization gate", async () => {
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const res = await request(app)
      .get(`/api/plugins/companies/${companyA}/memory-provider`);

    expect(res.status).toBe(501);
    expect(mockAccess.hasPermission).not.toHaveBeenCalled();
  });

  it("rejects plugin installation for non-admin board users", async () => {
    const { app, loader } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(403);
    expect(loader.installPlugin).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects remote instance admins from installing plugins in the SPS Core baseline", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    try {
      const { app, loader } = await createApp(boardActor({ isInstanceAdmin: true }));

      const res = await request(app)
        .post("/api/plugins/install")
        .send({ packageName: "paperclip-plugin-example" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only the SPS Host");
      expect(loader.installPlugin).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
    }
  }, 20_000);

  it("allows instance admins to install plugins", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const pluginKey = "paperclip.example";
    const discovered = {
      manifest: {
        id: pluginKey,
      },
    };

    mockRegistry.getByKey.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    });
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey,
      packageName: "paperclip-plugin-example",
      version: "1.0.0",
    });
    mockLifecycle.load.mockResolvedValue(undefined);

    const { app, loader } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      },
      { installPlugin: vi.fn().mockResolvedValue(discovered) },
    );

    const res = await request(app)
      .post("/api/plugins/install")
      .send({ packageName: "paperclip-plugin-example" });

    expect(res.status).toBe(200);
    expect(loader.installPlugin).toHaveBeenCalledWith({
      packageName: "paperclip-plugin-example",
      version: undefined,
    });
    expect(mockLifecycle.load).toHaveBeenCalledWith(pluginId);
  }, 20_000);

  it("rejects plugin upgrades for non-admin board users", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["delete", "delete", "/api/plugins/11111111-1111-4111-8111-111111111111", undefined],
    ["enable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/enable", {}],
    ["disable", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/disable", {}],
    ["config", "post", "/api/plugins/11111111-1111-4111-8111-111111111111/config", { configJson: {} }],
  ] as const)("rejects plugin %s for non-admin board users", async (_name, method, path, body) => {
    const { app } = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const req = method === "delete" ? request(app).delete(path) : request(app).post(path).send(body);
    const res = await req;

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
  }, 20_000);

  it("allows only the SPS Host to restart a ready plugin worker", async () => {
    readyPlugin();
    mockLifecycle.restartWorker.mockResolvedValue(undefined);
    const { app } = await createApp(boardActor({ source: "local_implicit" }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/worker/restart`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pluginId, restarted: true });
    expect(mockLifecycle.restartWorker).toHaveBeenCalledWith(pluginId);
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
  });

  it.each([
    ["disable", "post", `/api/plugins/${pluginId}/disable`],
    ["uninstall", "delete", `/api/plugins/${pluginId}`],
  ] as const)("does not mutate on unacknowledged %s dependency impact", async (_name, method, path) => {
    const provider = { id: pluginId, pluginKey: "sps.provider", version: "1.0.0", status: "ready", manifestJson: { id: "sps.provider" } };
    const consumer = { id: "22222222-2222-4222-8222-222222222222", pluginKey: "sps.consumer", version: "1.0.0", status: "ready", manifestJson: { id: "sps.consumer", requiredDependencies: [{ id: "sps.provider" }] } };
    mockRegistry.getById.mockResolvedValue(provider);
    mockRegistry.listInstalled.mockResolvedValue([provider, consumer]);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));
    const response = method === "post" ? await request(app).post(path).send({}) : await request(app).delete(path);
    expect(response.status).toBe(409);
    expect(response.body.impactReviewId).toEqual(expect.any(String));
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
  });

  it.each([
    ["disable", "post", `/api/plugins/${pluginId}/disable`],
    ["delete", "delete", `/api/plugins/${pluginId}`],
  ] as const)("allows an acknowledged Host %s without cascading to dependents", async (action, method, path) => {
    const provider = { id: pluginId, pluginKey: "sps.provider", version: "1.0.0", status: "ready", manifestJson: { id: "sps.provider" } };
    const consumer = { id: "22222222-2222-4222-8222-222222222222", pluginKey: "sps.consumer", version: "1.0.0", status: "ready", manifestJson: { id: "sps.consumer", requiredDependencies: [{ id: "sps.provider" }] } };
    mockRegistry.getById.mockResolvedValue(provider);
    mockRegistry.listInstalled.mockResolvedValue([provider, consumer]);
    mockLifecycle.disable.mockResolvedValue(provider);
    mockLifecycle.unload.mockResolvedValue(provider);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const preview = await request(app)
      .get(`/api/plugins/${pluginId}/dependency-impact`)
      .query({ action });
    expect(preview.status).toBe(200);
    const impactReviewId = preview.body.report.impact.reviewId as string;

    const response = method === "post"
      ? await request(app).post(path).send({ impactReviewId })
      : await request(app).delete(path).send({ impactReviewId });

    expect(response.status).toBe(200);
    if (method === "post") expect(mockLifecycle.disable).toHaveBeenCalledWith(pluginId, undefined);
    else expect(mockLifecycle.unload).toHaveBeenCalledWith(pluginId, false);
    expect(mockRegistry.listInstalled).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Host users before resolving a plugin worker restart", async () => {
    const { app } = await createApp(boardActor({ isInstanceAdmin: false }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/worker/restart`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockLifecycle.restartWorker).not.toHaveBeenCalled();
  });

  it("returns lifecycle readiness failures without duplicating worker state rules", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "installed",
      manifestJson: {},
    });
    mockLifecycle.restartWorker.mockRejectedValue(new Error("Plugin must be ready before restarting its worker"));
    const { app } = await createApp(boardActor({ source: "local_implicit" }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/worker/restart`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Plugin must be ready before restarting its worker" });
    expect(mockLifecycle.restartWorker).toHaveBeenCalledWith(pluginId);
  });

  it("resolves plugin keys without probing the UUID id column for core plugin actions", async () => {
    const pluginKey = "paperclipqa.hello-plugin";
    const plugin = {
      id: pluginId,
      pluginKey,
      version: "1.0.0",
      status: "ready",
      manifestJson: { id: pluginKey },
    };
    mockRegistry.getById.mockImplementation(() => {
      throw new Error("getById should not be called for plugin keys");
    });
    mockRegistry.getByKey.mockResolvedValue(plugin);
    mockLifecycle.unload.mockResolvedValue(plugin);
    mockLifecycle.enable.mockResolvedValue(plugin);
    mockLifecycle.disable.mockResolvedValue(plugin);

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    });

    const inspectRes = await request(app).get(`/api/plugins/${pluginKey}`);
    const disableRes = await request(app).post(`/api/plugins/${pluginKey}/disable`).send({});
    const enableRes = await request(app).post(`/api/plugins/${pluginKey}/enable`).send({});
    const uninstallRes = await request(app).delete(`/api/plugins/${pluginKey}?purge=true`);

    expect(inspectRes.status).toBe(200);
    expect(disableRes.status).toBe(200);
    expect(enableRes.status).toBe(200);
    expect(uninstallRes.status).toBe(200);
    expect(mockRegistry.getById).not.toHaveBeenCalled();
    expect(mockRegistry.getByKey).toHaveBeenCalledWith(pluginKey);
    expect(mockLifecycle.disable).toHaveBeenCalledWith(pluginId, undefined);
    expect(mockLifecycle.enable).toHaveBeenCalledWith(pluginId);
    expect(mockLifecycle.unload).toHaveBeenCalledWith(pluginId, true);
    expect(mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "plugin.uninstalled",
      details: expect.objectContaining({
        purge: true,
        deleteInboxSummaries: false,
        deletedInboxSummaries: 0,
      }),
    }));
  }, 20_000);

  it("deletes Inbox summaries only after successful unload and records the explicit choice", async () => {
    const plugin = {
      id: pluginId,
      pluginKey: "sps.team-workplane",
      version: "1.0.0",
      status: "ready",
      manifestJson: {},
    };
    mockRegistry.getByKey.mockResolvedValue(plugin);
    mockLifecycle.unload.mockResolvedValue(null);
    mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey.mockResolvedValue(3);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app)
      .delete(`/api/plugins/${plugin.pluginKey}?purge=true&deleteInboxSummaries=true`);

    expect(response.status).toBe(200);
    expect(mockLifecycle.unload).toHaveBeenCalledWith(pluginId, true);
    expect(mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey)
      .toHaveBeenCalledWith(plugin.pluginKey);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "plugin.uninstalled",
      details: expect.objectContaining({
        purge: true,
        deleteInboxSummaries: true,
        deletedInboxSummaries: 3,
      }),
    }));
  });

  it("does not delete Inbox summaries when lifecycle unload fails", async () => {
    const plugin = {
      id: pluginId,
      pluginKey: "sps.team-workplane",
      version: "1.0.0",
      status: "ready",
      manifestJson: {},
    };
    mockRegistry.getByKey.mockResolvedValue(plugin);
    mockLifecycle.unload.mockRejectedValue(new Error("worker did not stop"));
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app)
      .delete(`/api/plugins/${plugin.pluginKey}?deleteInboxSummaries=true`);

    expect(response.status).toBe(400);
    expect(mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey).not.toHaveBeenCalled();
  });

  it("returns an actionable maintenance conflict without claiming an uninstall or deleting history", async () => {
    const plugin = {
      id: pluginId, pluginKey: "sps.team-workplane", version: "1.0.0", status: "ready",
      manifestJson: { id: "sps.team-workplane" },
    };
    mockRegistry.getById.mockResolvedValue(plugin);
    mockLifecycle.unload.mockRejectedValueOnce(new PluginPackageMaintenanceRequiredError());
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app).delete(`/api/plugins/${pluginId}?deleteInboxSummaries=true`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "This package requires a maintenance window. Stop other plugins before removing it, then refresh and retry.",
      code: "plugin_package_maintenance_required",
    });
    expect(mockWorkspaceSurfaces.deleteInboxSummariesBySourcePluginKey).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockPublishGlobalLiveEvent).not.toHaveBeenCalled();
  }, 20_000);

  it("audits a completed lifecycle change when cleanup is pending, without exposing worker details", async () => {
    const plugin = {
      id: pluginId, pluginKey: "sps.team-workplane", version: "1.0.0", status: "ready",
      manifestJson: { id: "sps.team-workplane" },
    };
    mockRegistry.getById.mockResolvedValue(plugin);
    const completedFailure = new SpsPluginRuntimeCleanupPendingError(true, true);
    mockLifecycle.disable.mockRejectedValueOnce(completedFailure);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app).post(`/api/plugins/${pluginId}/disable`).send({ reason: "maintenance" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ operationStarted: true, operationCompleted: true, committed: true });
    expect(response.text).not.toContain("private workspace PID/path");
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "plugin.disabled", entityId: pluginId,
      details: expect.objectContaining({ operationCompleted: true, reason: "maintenance" }),
    }));
    expect(mockPublishGlobalLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "plugin.ui.updated", payload: { action: "runtime-cleanup-pending" },
    }));
  }, 20_000);

  it("rejects plugin config saves that contain secret refs even for instance admins", async () => {
    readyPlugin();

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/config`)
      .send({
        configJson: {
          apiKeyRef: "77777777-7777-4777-8777-777777777777",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/secret references are disabled/i);
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
  }, 20_000);

  it("allows instance admins to upgrade plugins", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
    });
    mockLifecycle.upgrade.mockResolvedValue({
      id: pluginId,
      version: "1.1.0",
    });

    const { app } = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({ version: "1.1.0" });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(pluginId, "1.1.0");
  }, 20_000);

  it("exposes a read-only migration plan only to instance admins", async () => {
    readyPlugin();
    const inspectPluginMigrations = vi.fn().mockResolvedValue({
      targetVersion: "1.1.0",
      reviewHash: "exact-plan-hash",
      requiresHostApproval: true,
      pendingMigrations: [{ migrationKey: "002_add_state.sql" }],
    });
    const { app } = await createApp(
      boardActor({ isInstanceAdmin: true }),
      { inspectPluginMigrations },
    );

    const res = await request(app).get(`/api/plugins/${pluginId}/migration-plan`);

    expect(res.status).toBe(200);
    expect(res.body.reviewHash).toBe("exact-plan-hash");
    expect(inspectPluginMigrations).toHaveBeenCalledWith(pluginId);
  }, 20_000);

  it("passes an explicit reviewed migration approval through the upgrade route", async () => {
    readyPlugin();
    mockLifecycle.upgrade.mockResolvedValue({ id: pluginId, version: "1.1.0" });
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/upgrade`)
      .send({
        version: "1.1.0",
        approvedDataMigrationPlanHash: "exact-plan-hash",
      });

    expect(res.status).toBe(200);
    expect(mockLifecycle.upgrade).toHaveBeenCalledWith(pluginId, {
      version: "1.1.0",
      approvedCapabilityEscalation: false,
      approvedDataMigrationPlanHash: "exact-plan-hash",
    });
  }, 20_000);
});

describe.sequential("scoped plugin API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches manifest-declared scoped routes after company access checks", async () => {
    const pluginId = "11111111-1111-4111-8111-111111111111";
    const workerManager = {
      call: vi.fn().mockResolvedValue({
        status: 202,
        body: { ok: true },
      }),
    };
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["api.routes.register"],
        apiRoutes: [
          {
            routeKey: "smoke",
            method: "GET",
            path: "/smoke",
            auth: "board-or-agent",
            capability: "api.routes.register",
            companyResolution: { from: "query", key: "companyId" },
          },
        ],
      },
    });

    const { app } = await createApp(
      {
        type: "board",
        userId: "admin-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: ["company-1"],
      },
      {},
      { bridgeDeps: { workerManager } },
    );

    const res = await request(app)
      .get("/api/plugins/paperclip.example/api/smoke")
      .query({ companyId: "company-1" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "handleApiRequest",
      expect.objectContaining({
        routeKey: "smoke",
        method: "GET",
        companyId: "company-1",
        query: { companyId: "company-1" },
      }),
    );
  }, 20_000);
});

describe.sequential("plugin local folder routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getCompanySettings.mockResolvedValue(null);
  });

  function readyLocalFolderPlugin() {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: "paperclip.example",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        id: "paperclip.example",
        capabilities: ["local.folders"],
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
            requiredDirectories: ["docs"],
            requiredFiles: ["README.md"],
          },
        ],
      },
    });
  }

  it("rejects validation for undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh/validate`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("rejects saving undeclared local folder keys", async () => {
    readyLocalFolderPlugin();
    const { app } = await createApp(boardActor());

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/local-folders/ssh`)
      .send({ path: "/tmp" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Local folder key is not declared");
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });
});

describe.sequential("plugin tool and bridge authz", () => {
  beforeAll(async () => {
    await Promise.all([
      import("../routes/plugins.js"),
      import("../middleware/index.js"),
    ]);
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getById.mockReset();
    mockRegistry.getByKey.mockReset();
    mockRegistry.getCompanySettings.mockReset();
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    mockRegistry.upsertCompanySettings.mockReset();
    mockRegistry.listInstalled.mockResolvedValue([]);
    mockAccess.canUser.mockReset();
    mockAccess.hasPermission.mockReset();
    mockAccess.canUser.mockResolvedValue(false);
    mockAccess.hasPermission.mockResolvedValue(false);
  });

  it("permits a projectless owned active Plugin Agent session without creating a Core project", async () => {
    readyPlugin();
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const taskKey = "plugin:paperclip.example:session:conversation";
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(agentActor(), {}, {
      db: createSelectQueueDb([
        [{ companyId: companyA, status: "running" }],
        [{ companyId: companyA, agentId: agentA, status: "running", contextSnapshot: {
          taskKey, spsPluginConversation: { pluginKey: "paperclip.example", sessionId, message: "Hello" },
        } }],
        [{ id: sessionId, companyId: companyA, agentId: agentA, taskKey, status: "active", closedAt: null }],
      ]),
      toolDeps: { toolDispatcher: {
        listToolsForAgent: vi.fn(),
        getTool: vi.fn(() => ({ pluginId: "paperclip.example", pluginDbId: pluginId, name: "search" })),
        executeTool,
      } },
    });
    const res = await request(app).post("/api/plugins/tools/execute").send({
      tool: "paperclip.example:search", parameters: {}, runContext: { agentId: agentA, companyId: companyA, runId: runA },
    });
    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith("paperclip.example:search", {}, { agentId: agentA, companyId: companyA, runId: runA });
  });

  it.each([boardActor(), agentActor({ runId: undefined }), agentActor({ runId: projectA }), agentActor({ source: "agent_key" })])(
    "rejects a projectless caller without the exact run-bound Agent identity: %j", async actor => {
      const executeTool = vi.fn();
      const { app } = await createApp(actor, {}, { toolDeps: { toolDispatcher: {
        listToolsForAgent: vi.fn(), getTool: vi.fn(), executeTool,
      } } });
      const res = await request(app).post("/api/plugins/tools/execute").send({
        tool: "paperclip.example:search", parameters: {}, runContext: { agentId: agentA, companyId: companyA, runId: runA },
      });
      expect(res.status).toBe(403);
      expect(executeTool).not.toHaveBeenCalled();
    },
  );

  it("rejects another plugin's tool from a projectless session", async () => {
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const taskKey = "plugin:paperclip.example:session:conversation";
    const executeTool = vi.fn();
    const { app } = await createApp(agentActor(), {}, {
      db: createSelectQueueDb([
        [{ companyId: companyA, status: "running" }],
        [{ companyId: companyA, agentId: agentA, status: "running", contextSnapshot: {
          taskKey, spsPluginConversation: { pluginKey: "paperclip.example", sessionId, message: "Hello" },
        } }],
        [{ id: sessionId, companyId: companyA, agentId: agentA, taskKey, status: "active", closedAt: null }],
      ]),
      toolDeps: { toolDispatcher: { listToolsForAgent: vi.fn(),
        getTool: vi.fn(() => ({ pluginId: "other.plugin", pluginDbId: pluginId, name: "search" })), executeTool } },
    });
    const res = await request(app).post("/api/plugins/tools/execute").send({
      tool: "other.plugin:search", runContext: { agentId: agentA, companyId: companyA, runId: runA },
    });
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects tool execution when the board user cannot access runContext.companyId", async () => {
    const executeTool = vi.fn();
    const getTool = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool,
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyB,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(403);
    expect(getTool).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects tool execution when any runContext reference is outside the company scope", async () => {
    const cases: Array<[string, Array<Array<Record<string, unknown>>>]> = [
      [
        "agentId",
        [
          [{ companyId: companyB }],
        ],
      ],
      [
        "runId company",
        [
          [{ companyId: companyA }],
          [{ companyId: companyB, agentId: agentA }],
        ],
      ],
      [
        "runId agent",
        [
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: "77777777-7777-4777-8777-777777777777" }],
        ],
      ],
      [
        "projectId",
        [
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: agentA }],
          [{ companyId: companyB }],
        ],
      ],
    ];

    for (const [label, rows] of cases) {
      const executeTool = vi.fn();
      const { app } = await createApp(boardActor(), {}, {
        db: createSelectQueueDb(rows),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
            executeTool,
          },
        },
      });

      const res = await request(app)
        .post("/api/plugins/tools/execute")
        .send({
          tool: "paperclip.example:search",
          parameters: {},
          runContext: {
            agentId: agentA,
            runId: runA,
            companyId: companyA,
            projectId: projectA,
          },
        });

      expect(res.status, label).toBe(403);
      expect(executeTool).not.toHaveBeenCalled();
    }
  });

  it("allows tool execution when agent, run, and project all belong to runContext.companyId", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(boardActor(), {}, {
      db: createSelectQueueDb([
        [{ companyId: companyA }],
        [{ companyId: companyA, agentId: agentA }],
        [{ companyId: companyA }],
      ]),
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent: vi.fn(),
          getTool: vi.fn(() => ({ name: "paperclip.example:search" })),
          executeTool,
        },
      },
    });

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: {
          agentId: agentA,
          runId: runA,
          companyId: companyA,
          projectId: projectA,
        },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      {
        agentId: agentA,
        runId: runA,
        companyId: companyA,
        projectId: projectA,
      },
    );
  });

  it.each([
    ["legacy data", "post", `/api/plugins/${pluginId}/bridge/data`, { key: "health" }],
    ["legacy action", "post", `/api/plugins/${pluginId}/bridge/action`, { key: "sync" }],
    ["url data", "post", `/api/plugins/${pluginId}/data/health`, {}],
    ["url action", "post", `/api/plugins/${pluginId}/actions/sync`, {}],
  ] as const)("rejects %s bridge calls without companyId for non-admin users", async (_name, _method, path, body) => {
    readyPlugin();
    const call = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(path)
      .send(body);

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("forwards authorized bridge company scope to the plugin worker", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/health`)
      .send({ companyId: companyA, params: { view: "compact" } });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "getData", {
      key: "health",
      companyId: companyA,
      params: { view: "compact" },
      renderEnvironment: null,
    });
  });

  it.each([
    ["legacy data", `/api/plugins/${pluginId}/bridge/data`, { key: "health", params: {} }, "getData"],
    ["legacy action", `/api/plugins/${pluginId}/bridge/action`, { key: "sync", params: {} }, "performAction"],
    ["url data", `/api/plugins/${pluginId}/data/health`, { params: {} }, "getData"],
    ["url action", `/api/plugins/${pluginId}/actions/sync`, { params: {} }, "performAction"],
  ] as const)("routes declared Workspace Worker %s through the owner-scoped caller", async (_name, path, body, method) => {
    const plugin = readyPlugin();
    plugin.manifestJson.entrypoints.workspaceWorker = "./workspace-worker.js";
    mockAccess.canUser.mockResolvedValue(true);
    const call = vi.fn(async (...args: any[]) => {
      await args[5].assertCurrent();
      return { ok: true };
    });
    const hostCall = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: { workerManager: { call: hostCall }, workspaceWorkers: { call } },
    });
    const res = await request(app).post(path).send({ ...body, companyId: companyA,
      params: method === "performAction" ? { __paperclipRequestedPermissions: ["agents:configure"] } : body.params });
    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(companyA, pluginId, method, expect.objectContaining({
      key: method === "getData" ? "health" : "sync",
    }), 30_000, expect.objectContaining({ boundWorkspaceId: companyA, assertCurrent: expect.any(Function) }));
    expect(hostCall).not.toHaveBeenCalled();
    if (method === "performAction") {
      expect(call.mock.calls[0]?.[3]).toMatchObject({
        params: { companyId: companyA },
        actorContext: { type: "user", userId: "user-1", companyId: companyA, permissions: ["agents:configure"] },
      });
    }
  });

  it("fails closed for a declared Workspace Worker when its caller or company scope is missing", async () => {
    const plugin = readyPlugin();
    plugin.manifestJson.entrypoints.workspaceWorker = "./workspace-worker.js";
    const hostCall = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: { workerManager: { call: hostCall } },
    });
    const scoped = await request(app).post(`/api/plugins/${pluginId}/data/health`).send({ companyId: companyA });
    const admin = await createApp(boardActor({ isInstanceAdmin: true, companyIds: [] }), {}, {
      bridgeDeps: { workerManager: { call: hostCall } },
    });
    const unscoped = await request(admin.app).post(`/api/plugins/${pluginId}/actions/sync`).send({});
    expect(scoped.status).toBe(502);
    expect(unscoped.status).toBe(502);
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("revokes a Workspace action invocation when its permission snapshot changes", async () => {
    const plugin = readyPlugin();
    plugin.manifestJson.entrypoints.workspaceWorker = "./workspace-worker.js";
    mockAccess.canUser.mockResolvedValue(true);
    const call = vi.fn(async (...args: any[]) => {
      mockAccess.canUser.mockResolvedValue(false);
      await args[5].assertCurrent();
      return { ok: true };
    });
    const hostCall = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: { workerManager: { call: hostCall }, workspaceWorkers: { call } },
    });
    const res = await request(app).post(`/api/plugins/${pluginId}/actions/sync`).send({
      companyId: companyA, params: { __paperclipRequestedPermissions: ["agents:configure"] },
    });
    expect(res.status).toBe(502);
    expect(call).toHaveBeenCalledOnce();
    expect(hostCall).not.toHaveBeenCalled();
  });

  it("allows omitted-company bridge calls for instance admins as global plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({});

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {},
      actorContext: {
        type: "user",
        userId: "admin-1",
        agentId: null,
        runId: null,
        companyId: null,
      },
      renderEnvironment: null,
    });
  });

  it("passes authenticated actor context and overrides spoofed company scope for plugin actions", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({ runId: runA }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerUserId: "spoofed-user",
        },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerUserId: "spoofed-user",
      },
      actorContext: {
        type: "user",
        userId: "user-1",
        agentId: null,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    });
  });

  it("adds host-calculated permissions to scoped plugin actions", async () => {
    readyPlugin();
    mockAccess.canUser.mockImplementation(async (_companyId: string, _userId: string, permissionKey: string) => permissionKey === "agents:configure");
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: { workerManager: { call } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: { __paperclipRequestedPermissions: ["agents:configure"] },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", expect.objectContaining({
      params: { companyId: companyA },
      actorContext: expect.objectContaining({ permissions: ["agents:configure"] }),
    }));
  });

  it("uses null for board actor userId when no authenticated user id is present", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(boardActor({ userId: undefined }), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyA });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", expect.objectContaining({
      actorContext: expect.objectContaining({
        type: "user",
        userId: null,
        companyId: companyA,
      }),
    }));
  });

  it("allows agent-scoped plugin actions with authenticated actor context", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerAgentId: "spoofed-agent",
        },
      });

    expect(res.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerAgentId: "spoofed-agent",
      },
      actorContext: {
        type: "agent",
        userId: null,
        agentId: agentA,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    });

    call.mockClear();
    const legacyRes = await request(app)
      .post(`/api/plugins/${pluginId}/bridge/action`)
      .send({
        key: "sync",
        companyId: companyA,
        params: {
          companyId: companyB,
          reviewerAgentId: "spoofed-agent",
        },
      });

    expect(legacyRes.status).toBe(200);
    expect(call).toHaveBeenCalledWith(pluginId, "performAction", {
      key: "sync",
      params: {
        companyId: companyA,
        reviewerAgentId: "spoofed-agent",
      },
      actorContext: {
        type: "agent",
        userId: null,
        agentId: agentA,
        runId: runA,
        companyId: companyA,
      },
      renderEnvironment: null,
    });
  });

  it("rejects agent plugin actions outside the authenticated company scope", async () => {
    readyPlugin();
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { app } = await createApp(agentActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/actions/sync`)
      .send({ companyId: companyB });

    expect(res.status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  });

  it("attaches worker bridge errors to the HTTP logger context", async () => {
    readyPlugin();
    const call = vi.fn().mockRejectedValue(new Error("missing source_objects column"));
    const captured: Array<{ context: any; body: unknown }> = [];
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: {
        workerManager: { call },
      },
      captureJsonContext: (context, body) => {
        captured.push({ context, body });
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/source-objects`)
      .send({ companyId: companyA });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "UNKNOWN",
      message: "missing source_objects column",
    });
    expect(captured.at(-1)?.context?.error).toMatchObject({
      message: "missing source_objects column",
      details: {
        pluginId,
        pluginKey: "paperclip.example",
        bridgeMethod: "getData",
        dataKey: "source-objects",
        bridgeCode: "UNKNOWN",
      },
    });
  });

  it("rejects manual job triggers for non-admin board users", async () => {
    const scheduler = { triggerJob: vi.fn() };
    const jobStore = { getJobByIdForPlugin: vi.fn() };
    const { app } = await createApp(boardActor(), {}, {
      jobDeps: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(403);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
  }, 15_000);

  it("allows manual job triggers for instance admins", async () => {
    readyPlugin();
    const scheduler = { triggerJob: vi.fn().mockResolvedValue({ runId: "run-1", jobId: "job-1" }) };
    const jobStore = { getJobByIdForPlugin: vi.fn().mockResolvedValue({ id: "job-1" }) };
    const { app } = await createApp(boardActor({
      userId: "admin-1",
      isInstanceAdmin: true,
      companyIds: [],
    }), {}, {
      jobDeps: { scheduler, jobStore },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/jobs/job-1/trigger`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: "run-1", jobId: "job-1" });
    expect(scheduler.triggerJob).toHaveBeenCalledWith("job-1", "manual");
  });

  // ─── Agent JWT tool execution (cherry-picked from #5549) ─────────────────────

  it("rejects board users with no company memberships from listing plugin tools", async () => {
    const listToolsForAgent = vi.fn(() => []);
    const { app } = await createApp(
      boardActor({ companyIds: [], isInstanceAdmin: false, source: "session" }),
      {},
      {
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent,
            getTool: vi.fn(),
            executeTool: vi.fn(),
          },
        },
      },
    );

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(403);
    expect(listToolsForAgent).not.toHaveBeenCalled();
  });

  it("allows agent JWT to list available plugin tools", async () => {
    const listToolsForAgent = vi.fn(() => []);
    const { app } = await createApp(agentActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent,
          getTool: vi.fn(),
          executeTool: vi.fn(),
        },
      },
    });

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(200);
    expect(listToolsForAgent).toHaveBeenCalled();
  });

  it("hides explicitly granted plugin tools from an Agent without a grant", async () => {
    mockRegistry.getById.mockResolvedValueOnce({
      id: pluginId,
      manifestJson: { agentToolAccess: "explicit_grant" },
    });
    const listToolsForAgent = vi.fn(() => [{
      name: "paperclip.example:remote-search",
      displayName: "Remote search",
      description: "Search a remote MCP server.",
      parametersSchema: {},
      pluginId: "paperclip.example",
    }]);
    const { app } = await createApp(agentActor(), {}, {
      db: createSelectQueueDb([[]]),
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent,
          getTool: vi.fn(() => ({
            namespacedName: "paperclip.example:remote-search",
            pluginDbId: pluginId,
          })),
          executeTool: vi.fn(),
        },
      },
    });

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("hides a Company-disabled plugin from an Agent tool list", async () => {
    mockRegistry.getById.mockResolvedValueOnce({
      id: pluginId,
      pluginKey: "paperclip.example",
      manifestJson: { companyActivation: { defaultEnabled: false } },
    });
    mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
    const listToolsForAgent = vi.fn(() => [{
      name: "paperclip.example:search",
      displayName: "Search",
      description: "Searches.",
      parametersSchema: {},
      pluginId: "paperclip.example",
    }]);
    const { app } = await createApp(agentActor(), {}, {
      toolDeps: {
        toolDispatcher: {
          listToolsForAgent,
          getTool: vi.fn(),
          executeTool: vi.fn(),
        },
      },
    });

    const res = await request(app).get("/api/plugins/tools");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("allows agent JWT to execute a tool within its company scope", async () => {
    const executeTool = vi.fn().mockResolvedValue({ content: "ok" });
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([
          [{ companyId: companyA }],
          [{ companyId: companyA, agentId: agentA }],
          [{ companyId: companyA }],
        ]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: { q: "test" },
        runContext: { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledWith(
      "paperclip.example:search",
      { q: "test" },
      { agentId: agentA, runId: runA, companyId: companyA, projectId: projectA },
    );
  });

  it("rejects Company-disabled plugin bridge calls before they reach the worker", async () => {
    mockRegistry.getById.mockResolvedValueOnce({
      id: pluginId,
      pluginKey: "paperclip.example",
      status: "ready",
      manifestJson: { companyActivation: { defaultEnabled: false } },
    });
    mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
    const call = vi.fn();
    const { app } = await createApp(boardActor(), {}, {
      bridgeDeps: { workerManager: { call } },
    });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/data/health`)
      .send({ companyId: companyA });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("disabled");
    expect(call).not.toHaveBeenCalled();
  });

  it("stores an explicit Company activation override without changing the Host package", async () => {
    mockRegistry.getById.mockResolvedValueOnce({
      id: pluginId,
      pluginKey: "paperclip.example",
      manifestJson: {},
    });
    mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
    mockRegistry.upsertCompanySettings.mockResolvedValueOnce({});
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.activation).toMatchObject({ enabled: false, source: "explicit" });
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(pluginId, companyA, {
      enabled: false,
      settingsJson: {},
      lastError: null,
    });
  });

  it("returns the saved Company activation and audit when scoped worker cleanup is pending", async () => {
    mockRegistry.getById.mockResolvedValue({
      id: pluginId, pluginKey: "paperclip.example", status: "ready", manifestJson: {},
    });
    mockRegistry.getCompanySettings.mockResolvedValueOnce(null);
    mockRegistry.upsertCompanySettings.mockResolvedValueOnce({});
    const reconcileWorkspacePolicy = vi.fn(async () => { throw new Error("private worker diagnostic"); });
    const reconcileCatalogPolicy = vi.fn(async () => {});
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }), {}, {
      bridgeDeps: { workspaceWorkers: { reconcileWorkspacePolicy, reconcileCatalogPolicy } },
    });

    const res = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: false });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ committed: true, activation: { enabled: false, source: "explicit" } });
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledTimes(1);
    expect(reconcileWorkspacePolicy).toHaveBeenCalledOnce();
    expect(reconcileWorkspacePolicy).toHaveBeenCalledWith(companyA);
    expect(reconcileCatalogPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "plugin.company_activation.updated", companyId: companyA,
    }));
    expect(res.text).not.toContain("private worker diagnostic");
  }, 20_000);

  it("rejects Company activation when the target dependency graph is blocked without mutating activation", async () => {
    const consumer = { id: pluginId, pluginKey: "sps.consumer", version: "1.0.0", status: "ready", manifestJson: { id: "sps.consumer", requiredDependencies: [{ id: "sps.required" }] } };
    mockRegistry.getById.mockResolvedValue(consumer);
    mockRegistry.listInstalled.mockResolvedValue([consumer]);
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: true });

    expect(response.status).toBe(409);
    expect(response.body.report.issues).toContainEqual(expect.objectContaining({ code: "MISSING_REQUIRED", pluginId: "sps.consumer" }));
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("requires impact acknowledgement before Company deactivation breaks an active dependent", async () => {
    const provider = { id: pluginId, pluginKey: "sps.provider", version: "1.0.0", status: "ready", manifestJson: { id: "sps.provider" } };
    const consumer = { id: "22222222-2222-4222-8222-222222222222", pluginKey: "sps.consumer", version: "1.0.0", status: "ready", manifestJson: { id: "sps.consumer", requiredDependencies: [{ id: "sps.provider" }] } };
    mockRegistry.getById.mockResolvedValue(provider);
    mockRegistry.listInstalled.mockResolvedValue([provider, consumer]);
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const response = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: false });

    expect(response.status).toBe(409);
    expect(response.body.impactReviewId).toEqual(expect.any(String));
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("allows the reviewed Company deactivation without changing another plugin", async () => {
    const provider = { id: pluginId, pluginKey: "sps.provider", version: "1.0.0", status: "ready", manifestJson: { id: "sps.provider" } };
    const consumer = { id: "22222222-2222-4222-8222-222222222222", pluginKey: "sps.consumer", version: "1.0.0", status: "ready", manifestJson: { id: "sps.consumer", requiredDependencies: [{ id: "sps.provider" }] } };
    mockRegistry.getById.mockResolvedValue(provider);
    mockRegistry.listInstalled.mockResolvedValue([provider, consumer]);
    mockRegistry.getCompanySettings.mockResolvedValue(null);
    mockRegistry.upsertCompanySettings.mockResolvedValue({});
    const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

    const preview = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: false });
    expect(preview.status).toBe(409);

    const response = await request(app)
      .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
      .send({ enabled: false, impactReviewId: preview.body.impactReviewId });

    expect(response.status).toBe(200);
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledWith(pluginId, companyA, {
      enabled: false,
      settingsJson: {},
      lastError: null,
    });
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote legacy instance admin from changing Company activation in the SPS Core baseline", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    try {
      const { app } = await createApp(boardActor({ isInstanceAdmin: true }));

      const res = await request(app)
        .put(`/api/plugins/${pluginId}/companies/${companyA}/activation`)
        .send({ enabled: false });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("Only the SPS Host");
      expect(mockRegistry.getById).not.toHaveBeenCalled();
      expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
    }
  });

  it("rejects agent JWT when runContext.companyId is outside the agent's company scope", async () => {
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: agentA, runId: runA, companyId: companyB, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects agent JWT when runContext.agentId does not belong to runContext.companyId", async () => {
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        db: createSelectQueueDb([
          [{ companyId: companyB }],
        ]),
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: otherAgent, runId: runA, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects an Agent token that attempts to execute a tool as another Agent", async () => {
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: otherAgent, runId: runA, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("own Agent identity");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects an Agent token that attempts to execute a tool under another run", async () => {
    const otherRun = "88888888-8888-4888-8888-888888888888";
    const executeTool = vi.fn();
    const { app } = await createApp(
      agentActor(),
      {},
      {
        toolDeps: {
          toolDispatcher: {
            listToolsForAgent: vi.fn(),
            getTool: vi.fn(() => ({ name: "paperclip.example:search", pluginDbId: pluginId })),
            executeTool,
          },
        },
      },
    );

    const res = await request(app)
      .post("/api/plugins/tools/execute")
      .send({
        tool: "paperclip.example:search",
        parameters: {},
        runContext: { agentId: agentA, runId: otherRun, companyId: companyA, projectId: projectA },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("own run");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("passes only the Host or Member audience to canonical diagnostics", async () => {
    readyPlugin();
    const snapshot = {
      schemaVersion: "sps-plugin-diagnostic/v1",
      pluginId,
      pluginKey: "paperclip.example",
      generatedAt: new Date().toISOString(),
      facts: [],
      runtime: { lifecycleStatus: "ready", declaredCapabilities: [], worker: null, scheduler: null },
    };
    const diagnostics = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    const { app } = await createApp(boardActor({ source: "local_implicit", companyIds: [] }), {}, { diagnosticsDeps: { diagnostics } });
    const hostResponse = await request(app).get(`/api/plugins/${pluginId}/diagnostics`);
    expect(hostResponse.status).toBe(200);
    expect(diagnostics.snapshot).toHaveBeenLastCalledWith(pluginId, "host");

    const memberDiagnostics = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    const member = await createApp(boardActor(), {}, { diagnosticsDeps: { diagnostics: memberDiagnostics } });
    const memberResponse = await request(member.app).get(`/api/plugins/${pluginId}/diagnostics`);
    expect(memberResponse.status).toBe(200);
    expect(memberDiagnostics.snapshot).toHaveBeenLastCalledWith(pluginId, "member");
  });

  it("rejects Agent credentials before canonical diagnostics are resolved", async () => {
    readyPlugin();
    const diagnostics = { snapshot: vi.fn() };
    const { app } = await createApp(agentActor(), {}, { diagnosticsDeps: { diagnostics } });
    const response = await request(app).get(`/api/plugins/${pluginId}/diagnostics`);
    expect(response.status).toBe(403);
    expect(diagnostics.snapshot).not.toHaveBeenCalled();
  });
});

describe.sequential("plugin recovery gate routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.listInstalled.mockResolvedValue([]);
  });

  const recoveryState = () => resolvePluginRecoveryState("all-disabled");
  const pluginRecord = (status = "ready") => ({
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "@example/plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    status,
    installOrder: 1,
    packagePath: "C:/plugins/example",
    lastError: "plugin-provided detail",
    manifestJson: {
      id: "paperclip.example",
      version: "1.0.0",
      ui: { slots: [{ type: "page", routePath: "/example" }] },
    },
    installedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  it("returns sanitized package status without manifest contributions or host paths", async () => {
    mockRegistry.listInstalled.mockResolvedValue([pluginRecord()]);
    const { app } = await createApp(boardActor(), {}, { recoveryState: recoveryState() });

    const response = await request(app).get("/api/plugins");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([{
      id: pluginId,
      pluginKey: "paperclip.example",
      packageName: "@example/plugin",
      status: "ready",
      manifestJson: null,
    }]);
    expect(response.body[0]).not.toHaveProperty("packagePath");
    expect(response.body[0]).not.toHaveProperty("lastError");
  });

  it("blocks UI contributions and installation, and still requires authentication", async () => {
    const loaderInstall = vi.fn();
    const { app, loader } = await createApp(boardActor(), { installPlugin: loaderInstall }, {
      recoveryState: recoveryState(),
    });

    const contributions = await request(app).get("/api/plugins/ui-contributions");
    const install = await request(app).post("/api/plugins/install").send({ packageName: "@example/plugin" });

    expect(contributions.status).toBe(423);
    expect(contributions.body.code).toBe("plugin_recovery_active");
    expect(install.status).toBe(423);
    expect(loader.installPlugin).not.toHaveBeenCalled();
    expect(mockRegistry.listByStatus).not.toHaveBeenCalled();

    const anonymous = await createApp({ type: "none" }, {}, { recoveryState: recoveryState() });
    const unauthenticated = await request(anonymous.app).post("/api/plugins/install").send({});
    expect(unauthenticated.status).toBe(401);
  });

  it("blocks unsupported package and activation mutations without changing persisted choices", async () => {
    const persisted = {
      package: { status: "ready", version: "1.0.0", configJson: { retained: true } },
      activation: { enabled: true, settingsJson: { retained: true } },
    };
    const before = structuredClone(persisted);
    const loaderInstall = vi.fn().mockImplementation(async () => {
      persisted.package.status = "ready";
      persisted.package.version = "2.0.0";
      return { manifest: { id: "paperclip.example" } };
    });
    mockLifecycle.upgrade.mockImplementation(async () => {
      persisted.package.version = "2.0.0";
    });
    mockLifecycle.enable.mockImplementation(async () => {
      persisted.package.status = "ready";
    });
    mockLifecycle.unload.mockImplementation(async () => {
      persisted.package.status = "uninstalled";
    });
    mockRegistry.upsertConfig.mockImplementation(async (_pluginId, configJson) => {
      persisted.package.configJson = configJson;
    });
    mockRegistry.upsertCompanySettings.mockImplementation(async (_pluginId, _companyId, settings) => {
      persisted.activation = settings;
    });
    const { app, loader } = await createApp(
      boardActor({ isInstanceAdmin: true }),
      { installPlugin: loaderInstall },
      { recoveryState: recoveryState() },
    );

    const attempts = [
      request(app).post("/api/plugins/install").send({ packageName: "@example/plugin" }),
      request(app).post(`/api/plugins/${pluginId}/upgrade`).send({}),
      request(app).post(`/api/plugins/${pluginId}/enable`).send({}),
      request(app).post(`/api/plugins/${pluginId}/config`).send({ configJson: { changed: true } }),
      request(app).delete(`/api/plugins/${pluginId}`),
      request(app).put(`/api/plugins/${pluginId}/companies/${companyA}/activation`).send({ enabled: false }),
      request(app).get("/api/plugins/tools"),
      request(app).post(`/api/plugins/${pluginId}/data/health`).send({}),
    ];
    const responses = await Promise.all(attempts);

    expect(responses.map((response) => [response.status, response.body.code])).toEqual(
      responses.map(() => [423, "plugin_recovery_active"]),
    );
    expect(persisted).toEqual(before);
    expect(loader.installPlugin).not.toHaveBeenCalled();
    expect(mockLifecycle.upgrade).not.toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(mockLifecycle.unload).not.toHaveBeenCalled();
    expect(mockRegistry.upsertConfig).not.toHaveBeenCalled();
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("retains package-status and Host-disable authorization checks", async () => {
    const unauthorizedApp = await createApp({ type: "none" }, {}, { recoveryState: recoveryState() });
    const status = await request(unauthorizedApp.app).get("/api/plugins");
    expect(status.status).toBe(403);
    expect(mockRegistry.listInstalled).not.toHaveBeenCalled();

    const memberApp = await createApp(boardActor(), {}, { recoveryState: recoveryState() });
    const disable = await request(memberApp.app).post(`/api/plugins/${pluginId}/disable`).send({});
    expect(disable.status).toBe(403);
    expect(mockLifecycle.disable).not.toHaveBeenCalled();
  });

  it("keeps the authenticated Host disable action available", async () => {
    const ready = pluginRecord();
    const disabled = pluginRecord("disabled");
    mockRegistry.getById.mockResolvedValue(ready);
    mockRegistry.listInstalled.mockResolvedValue([ready]);
    mockLifecycle.disable.mockResolvedValue(disabled);
    const { app } = await createApp(boardActor({ source: "local_implicit", companyIds: [] }), {}, {
      recoveryState: recoveryState(),
    });

    const response = await request(app)
      .post(`/api/plugins/${pluginId}/disable`)
      .send({ reason: "recovery" });

    expect(response.status).toBe(200);
    expect(mockLifecycle.disable).toHaveBeenCalledWith(pluginId, "recovery");
  });
});
