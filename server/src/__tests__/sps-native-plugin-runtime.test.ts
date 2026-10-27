import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
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
  SpsNativePluginUnsupportedError, type SpsNativePluginPrincipal, type SpsNativePluginRequest } from "../services/sps-native-plugin-runtime.js";
import { spsWorkspaceSurfaceService } from "../services/sps-workspace-surfaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const principal: SpsNativePluginPrincipal = Object.freeze({ hostId: randomUUID(), userId: "native-user",
  deviceId: randomUUID(), deviceRevision: 1, certificateSha256: "a".repeat(64),
  certificateNotAfter: Date.now() + 60 * 60_000 });
let localPluginDir = "";

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
    entrypoints: { worker: "./worker.js", ui: "./dist/ui/" },
    ui: {
      slots: [
        { type: "page", id: "first-page", displayName: "First page", exportName: "FirstPage", routePath: "start" },
        { type: "page", id: "fixture-page", displayName: "Fixture page", exportName: "HomePage", routePath: "home" },
      ],
      workspaceShell: { id: "fixture-shell", displayName: "Fixture shell", defaultRoute: "/home", navigation: [] },
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
    localPluginDir = await mkdtemp(path.join(os.tmpdir(), "sps-native-plugin-runtime-files-"));
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
    if (localPluginDir && pluginId) await rm(path.join(localPluginDir, pluginId), { recursive: true, force: true });
  }, 30_000);

  afterAll(async () => {
    // Bound the owned client drain before the helper's bounded pg_ctl shutdown.
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    if (localPluginDir) await rm(localPluginDir, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    companyId = randomUUID();
    pluginId = randomUUID();
    const pluginManifest = manifest();
    const packagePath = path.join(localPluginDir, pluginId);
    const uiRoot = path.join(packagePath, "dist", "ui");
    await mkdir(path.join(uiRoot, "assets"), { recursive: true });
    await writeFile(path.join(uiRoot, "index.js"), "export const HomePage = () => null;\n");
    await writeFile(path.join(uiRoot, "fixture.css"), "body { color: black; }\n");
    await writeFile(path.join(uiRoot, "assets", "chunk.js"), "export const chunk = true;\n");
    await db.insert(companies).values({ id: companyId, name: "Native runtime Workspace",
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginManifest.id,
      packageName: "@sps/native-runtime-fixture", version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion, categories: pluginManifest.categories,
      packagePath, manifestJson: pluginManifest, status: "ready" });
    worker = { call: vi.fn(async (_id: string, _method: string, _params: unknown, _timeout: number,
      authority?: WorkerInvocationAuthority) => {
      await authority?.assertCurrent();
      return { ok: true };
    }) };
    runtime = createSpsNativePluginRuntime(db, worker as unknown as PluginWorkerManager, { localPluginDir });
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

  it("describes only the selected declared surface and serves revision-bound bounded assets", async () => {
    await seed();
    await spsWorkspaceSurfaceService(db).selectShell({ companyId, userId: principal.userId, pluginId });

    const shell = await runtime!.invoke(request({ surface: "shell", surfaceId: "fixture-shell", operation: "describe",
      revision: null, key: "surface", params: {} }), authorize) as Record<string, unknown>;
    expect(shell).toEqual({
      v: 1,
      kind: "sps.native.plugin.surface",
      workspaceId: companyId,
      pluginId,
      pluginKey: expect.stringMatching(/^sps\.native-runtime-/),
      displayName: "Native runtime fixture",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      surface: "shell",
      surfaceId: "fixture-shell",
      entryFile: "index.js",
      exportName: "HomePage",
      widget: null,
      slot: { type: "page", id: "fixture-page", displayName: "Fixture page", exportName: "HomePage", routePath: "home" },
      cssFiles: ["fixture.css"],
    });

    const widgetValue = await runtime!.invoke(request({ operation: "describe", revision: null, key: "surface", params: {} }), authorize);
    const widget = widgetValue as Record<string, unknown>;
    expect(widget).toMatchObject({
      kind: "sps.native.plugin.surface", surface: "widget", surfaceId: "fixture-widget",
      exportName: "Widget", slot: null, widget: { id: "fixture-widget", dataAction: "widget.data" },
    });
    const revision = widget.revision as string;
    const assetValue = await runtime!.invoke(request({ operation: "asset", revision, key: "assets/chunk.js", params: {} }), authorize);
    const asset = assetValue as Record<string, unknown>;
    expect(asset).toMatchObject({ path: "assets/chunk.js", contentType: "text/javascript; charset=utf-8",
      bytes: Buffer.from("export const chunk = true;\n").toString("base64url"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(worker.call).not.toHaveBeenCalled();
    await expect(runtime!.invoke(request({ operation: "asset", revision: "f".repeat(64), key: "assets/chunk.js", params: {} }), authorize))
      .rejects.toThrow("unavailable");
  }, 60_000);

  it("reports an explicit unsupported error when the selected Shell has no renderable page", async () => {
    await seed();
    await spsWorkspaceSurfaceService(db).selectShell({ companyId, userId: principal.userId, pluginId });
    const current = manifest();
    current.ui!.slots = [];
    await db.update(plugins).set({ manifestJson: current }).where(eq(plugins.id, pluginId));

    await expect(runtime!.invoke(request({ surface: "shell", surfaceId: "fixture-shell", operation: "describe",
      revision: null, key: "surface", params: {} }), authorize)).rejects.toBeInstanceOf(SpsNativePluginUnsupportedError);
    expect(worker.call).not.toHaveBeenCalled();
  }, 60_000);

  it("provides only current Native request evidence and rejects reads after invocation cancellation", async () => {
    await seed();
    let retained: WorkerInvocationAuthority | undefined;
    worker.call.mockImplementationOnce(async (_id, _method, _params, _timeout, authority) => {
      retained = authority;
      const status = await authority!.readNativeConnectivity!();
      expect(status).toEqual({ state: "verified", transport: "native_tls", hostId: principal.hostId,
        workspaceId: companyId, authorization: "authorized", evidence: "authenticated_request",
        observedAt: expect.any(String) });
      return status;
    });
    await expect(runtime!.invoke(request({ operation: "data" }), authorize)).resolves.toMatchObject({
      state: "verified", hostId: principal.hostId, workspaceId: companyId,
    });
    await expect(retained!.readNativeConnectivity!()).rejects.toThrow("unavailable");
    worker.call.mockImplementationOnce(async (_id, _method, _params, _timeout, authority) => {
      await db.insert(pluginCompanySettings).values({ pluginId, companyId, enabled: false, settingsJson: {} });
      return authority!.readNativeConnectivity!();
    });
    await expect(runtime!.invoke(request({ operation: "data" }), authorize)).rejects.toThrow("unavailable");
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
