import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  plugins,
  spsDashboardLayoutItems,
  spsWorkspaceShellSettings,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginWorkerManager, WorkerInvocationAuthority } from "../services/plugin-worker-manager.js";
import { createSpsNativePluginRuntime, snapshotSpsNativePluginJson,
  type SpsNativePluginPrincipal, type SpsNativePluginRequest } from "../services/sps-native-plugin-runtime.js";
import { spsWorkspaceSurfaceService } from "../services/sps-workspace-surfaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const principal: SpsNativePluginPrincipal = Object.freeze({ userId: "native-user",
  deviceId: randomUUID(), deviceRevision: 1, certificateSha256: "a".repeat(64),
  certificateNotAfter: Date.now() + 60 * 60_000 });

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: `sps.native-runtime-${randomUUID()}`,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Native runtime fixture",
    description: "Test-only active Workspace plugin.",
    author: "SPS",
    categories: ["automation"],
    capabilities: ["ui.dashboard.contribute", "ui.workspaceShell.provide"],
    entrypoints: { worker: "./worker.js" },
    ui: {
      workspaceShell: { id: "fixture-shell", displayName: "Fixture shell", navigation: [] },
      dashboardWidgets: [{ id: "fixture-widget", displayName: "Fixture widget", exportName: "Widget",
        defaultSize: "medium", sizes: ["small", "medium", "large"], defaultOrder: 1, dataAction: "widget.data" }],
    },
  };
}

describeDatabase("SPS Native Plugin runtime adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId = "";
  let pluginId = "";
  let worker: { call: ReturnType<typeof vi.fn> };
  let runtime: ReturnType<typeof createSpsNativePluginRuntime> | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-plugin-runtime-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterEach(async () => {
    runtime?.dispose();
    runtime = undefined;
    if (!db) return;
    await db.delete(spsDashboardLayoutItems);
    await db.delete(spsWorkspaceShellSettings);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  }, 30_000);

  async function seed() {
    companyId = randomUUID();
    pluginId = randomUUID();
    const pluginManifest = manifest();
    await db.insert(companies).values({ id: companyId, name: "Native runtime Workspace",
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginManifest.id,
      packageName: "@sps/native-runtime-fixture", version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion, categories: pluginManifest.categories,
      manifestJson: pluginManifest, status: "ready" });
    worker = { call: vi.fn(async (_id: string, _method: string, _params: unknown, _timeout: number,
      authority?: WorkerInvocationAuthority) => {
      await authority?.assertCurrent();
      return { ok: true };
    }) };
    runtime = createSpsNativePluginRuntime(db, worker as unknown as PluginWorkerManager);
  }

  const request = (overrides: Partial<SpsNativePluginRequest> = {}): SpsNativePluginRequest => ({
    workspaceId: companyId, pluginId, surface: "widget", surfaceId: "fixture-widget",
    operation: "action", key: "widget.activate", params: {}, ...overrides,
  });
  const authorize = async () => principal;

  it("dispatches only a ready, Workspace-enabled plugin's declared widget and forces its user/company actor", async () => {
    await seed();
    const params = { companyId: randomUUID(), __paperclipRequestedPermissions: ["agents:create", "not-a-permission"] };
    await expect(runtime!.invoke(request({ params }), authorize)).resolves.toEqual({ ok: true });
    expect(worker.call).toHaveBeenCalledTimes(1);
    const [calledPluginId, method, payload, , authority] = worker.call.mock.calls[0]!;
    expect(calledPluginId).toBe(pluginId);
    expect(method).toBe("performAction");
    expect(payload).toMatchObject({ companyId, key: "widget.activate", params: { companyId } });
    expect((payload as { params: Record<string, unknown> }).params).not.toHaveProperty("__paperclipRequestedPermissions");
    expect((payload as { actorContext: Record<string, unknown> }).actorContext).toMatchObject({
      type: "user", userId: principal.userId, agentId: null, runId: null, companyId,
    });
    expect(authority).toMatchObject({ assertCurrent: expect.any(Function), signal: expect.any(AbortSignal) });

    await spsWorkspaceSurfaceService(db).selectShell({ companyId, userId: principal.userId, pluginId });
    await expect(runtime!.invoke(request({ surface: "shell", surfaceId: "fixture-shell", operation: "data" }), authorize))
      .resolves.toEqual({ ok: true });

    await expect(runtime!.invoke(request({ surfaceId: "undeclared-widget" }), authorize)).rejects.toThrow("unavailable");
    await expect(runtime!.invoke(request({ surface: "shell", surfaceId: "undeclared-shell" }), authorize))
      .rejects.toThrow("unavailable");
    expect(worker.call).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch when the plugin is ready but deactivated for this Workspace", async () => {
    await seed();
    await db.insert(pluginCompanySettings).values({ pluginId, companyId, enabled: false, settingsJson: {} });
    await expect(runtime!.invoke(request({ operation: "data" }), authorize)).rejects.toThrow("unavailable");
    expect(worker.call).not.toHaveBeenCalled();
  });

  it("checks Workspace activation again before accepting a worker result", async () => {
    await seed();
    worker.call.mockImplementationOnce(async (_id, _method, _params, _timeout, authority) => {
      await db.insert(pluginCompanySettings).values({ pluginId, companyId, enabled: false, settingsJson: {} });
      await authority?.assertCurrent();
      return { shouldNeverReachCaller: true };
    });
    await expect(runtime!.invoke(request({ operation: "data" }), authorize)).rejects.toThrow("unavailable");
    expect(worker.call).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch while plugin recovery mode is active", async () => {
    await seed();
    const original = process.env.SPS_PLUGIN_RECOVERY_MODE;
    process.env.SPS_PLUGIN_RECOVERY_MODE = "all-disabled";
    try {
      await expect(runtime!.invoke(request({ operation: "data" }), authorize)).rejects.toThrow("unavailable");
      expect(worker.call).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.SPS_PLUGIN_RECOVERY_MODE;
      else process.env.SPS_PLUGIN_RECOVERY_MODE = original;
    }
  });

  it("fails closed before dispatch when native authority is already revoked", async () => {
    await seed();
    const revoked = vi.fn(async (): Promise<SpsNativePluginPrincipal> => { throw new Error("revoked"); });
    await expect(runtime!.invoke(request({ operation: "data" }), revoked)).rejects.toThrow("unavailable");
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(worker.call).not.toHaveBeenCalled();
  });

  it("rechecks authority inside worker dispatch and discards a result after revocation", async () => {
    await seed();
    let calls = 0;
    const revokedDuringCall = async () => {
      calls++;
      if (calls >= 3) throw new Error("session revoked");
      return principal;
    };
    worker.call.mockImplementationOnce(async (_id, _method, _params, _timeout, authority) => {
      await authority?.assertCurrent();
      return { shouldNeverReachCaller: true };
    });
    await expect(runtime!.invoke(request({ operation: "data" }), revokedDuringCall)).rejects.toThrow("unavailable");
    expect(worker.call).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe object graphs without evaluating getters and bounds serialized results", () => {
    const getter = vi.fn(() => "secret");
    const withGetter = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotSpsNativePluginJson(withGetter, 100)).toThrow("unavailable");
    expect(getter).not.toHaveBeenCalled();
    expect(() => snapshotSpsNativePluginJson(cycle, 100)).toThrow("unavailable");
    expect(() => snapshotSpsNativePluginJson({ text: "x".repeat(150), nested: ["ok"] }, 32))
      .toThrow("unavailable");
    expect(snapshotSpsNativePluginJson({ nested: ["ok", 1] }, 100)).toEqual({ nested: ["ok", 1] });
  });
});
