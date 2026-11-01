import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const registry = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn(), listInstalled: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => registry }));

import { pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";

const worker = fileURLToPath(new URL("./fixtures/plugin-worker-shutdown.cjs", import.meta.url));
const pluginId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const manifest: PaperclipPluginManifestV1 = {
  id: "test.artifact-maintenance", version: "1.0.0", apiVersion: 1, displayName: "Owned fixture",
  description: "Maintenance integration fixture", author: "SPS", categories: ["automation"], capabilities: [],
  entrypoints: { worker: "worker.cjs" },
};
const startOptions = (): WorkerStartOptions => ({ entrypointPath: worker, manifest, config: {},
  instanceInfo: { instanceId: "artifact-maintenance-test", hostVersion: "1" }, apiVersion: 1,
  hostHandlers: {}, autoRestart: false });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("shared artifact maintenance integration", () => {
  const roots = new Set<string>();
  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots.clear();
    vi.clearAllMocks();
  });

  it("rejects loader imports, mutations and activation before IO while allowing private reference reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sps-artifact-maintenance-"));
    roots.add(root);
    const maintenance = createSpsPluginArtifactMaintenance();
    const loader = pluginLoader({} as never, { localPluginDir: path.join(root, "packages"), artifactMaintenance: maintenance });
    const calls = [
      () => loader.discoverAll(), () => loader.discoverFromLocalFilesystem(), () => loader.discoverFromNpm(),
      () => loader.loadManifest(root), () => loader.installPlugin({ localPath: root }),
      () => loader.previewRegistryPluginEnable({ localPath: root, staticManifest: {} as never }),
      () => loader.prepareUpgrade(pluginId, {}), () => loader.commitPreparedUpgrade(pluginId, {} as never),
      () => loader.upgradePlugin(pluginId, {}), () => loader.inspectPluginMigrations(pluginId),
      () => loader.cleanupInstallArtifacts({ id: pluginId } as never, {} as never),
      () => loader.loadAll(), () => loader.loadSingle(pluginId), () => loader.unloadSingle(pluginId, manifest.id),
    ];
    await maintenance.withMaintenance(async () => {
      for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      expect(loader.readPreparedArtifactReferences!()).toEqual([]);
      expect(await readdir(root)).toEqual([]);
      expect(registry.getById).not.toHaveBeenCalled();
      expect(registry.update).not.toHaveBeenCalled();
    });
    expect(await loader.loadManifest(root)).toBeNull();
  });

  it("holds direct preparation from its first registry await and releases a known failure", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const entered = deferred(), release = deferred();
    const failure = new Error("controlled preparation read failure");
    registry.getById.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw failure; });
    const loader = pluginLoader({} as never, { artifactMaintenance: maintenance });
    const preparing = loader.prepareUpgrade(pluginId, {});
    const rejected = expect(preparing).rejects.toBe(failure);
    try {
      await entered.promise;
      await expect(maintenance.withMaintenance(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      expect(() => loader.readPreparedArtifactReferences!()).toThrow(/unavailable/);
    } finally { release.resolve(); await rejected; }
    expect(loader.readPreparedArtifactReferences!()).toEqual([]);
    await maintenance.withMaintenance(async () => {});
  });

  it("holds the actual commit write until its acknowledgement, without granting deletion", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const entered = deferred(), release = deferred();
    registry.update.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const loader = pluginLoader({} as never, { artifactMaintenance: maintenance });
    const committing = loader.commitPreparedUpgrade(pluginId, { oldManifest: manifest, newManifest: manifest,
      discovered: { packageName: "@sps/fixture", packagePath: path.dirname(worker), version: "1.0.0", manifest } });
    try {
      await entered.promise;
      await expect(maintenance.withMaintenance(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      expect(loader.readPreparedArtifactReferences!()).toMatchObject([{ artifactRoot: path.dirname(worker), phase: "committing" }]);
    } finally { release.resolve(); await committing; }
    await maintenance.withMaintenance(async () => { expect(loader.readPreparedArtifactReferences!()).toEqual([]); });
  });

  it("denies lifecycle before the existing draining coordinator and tracks its entire pending operation", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const entered = deferred(), release = deferred();
    const workspaceRuntime = {
      withPluginMutation: vi.fn(async <T>(_id: string, action: () => Promise<T>) => {
        entered.resolve(); await release.promise; return action();
      }),
      reconcileCatalogPolicy: vi.fn(async () => {}),
    };
    registry.getById.mockResolvedValue(null);
    const lifecycle = pluginLifecycleManager({} as never, { artifactMaintenance: maintenance, workspaceRuntime });
    await maintenance.withMaintenance(async () => {
      await expect(lifecycle.disable(pluginId)).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      await expect(lifecycle.recoverPackageOperations!()).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      expect(workspaceRuntime.withPluginMutation).not.toHaveBeenCalled();
      expect(registry.getById).not.toHaveBeenCalled();
    });
    const disabling = lifecycle.disable(pluginId);
    const rejected = expect(disabling).rejects.toThrow(/not found/i);
    try {
      await entered.promise;
      await expect(maintenance.withMaintenance(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    } finally { release.resolve(); await rejected; }
    expect(workspaceRuntime.reconcileCatalogPolicy).toHaveBeenCalledOnce();
    await maintenance.withMaintenance(async () => {});
  });

  it("keeps an actual running Worker alive while rejecting new and retained-handle starts", async () => {
    const manager = createPluginWorkerManager();
    const maintenance = manager.artifactMaintenance!;
    try {
      const handle = await manager.startWorker(pluginId, startOptions());
      const before = handle.diagnostics();
      expect(before.pid).not.toBeNull();
      await maintenance.withMaintenance(async () => {
        await expect(manager.startWorkspaceWorker(workspaceId, pluginId, startOptions())).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
        await expect(handle.restart()).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
        await expect(manager.withPluginPackageMutation!(pluginId, async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
        expect(handle.diagnostics()).toMatchObject({ pid: before.pid, status: "running" });
        expect(manager.readArtifactReferences!()).toMatchObject([{ entrypointPath: worker, status: "running" }]);
      });
      await handle.stop();
      await maintenance.withMaintenance(async () => {
        await expect(handle.start()).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
        expect(handle.diagnostics()).toMatchObject({ pid: null, status: "stopped" });
      });
      await handle.start();
      expect(handle.status).toBe("running");
    } finally { await manager.shutdown(); }
  });

  it("protects a real admitted Worker initialization before it settles", async () => {
    const manager = createPluginWorkerManager();
    try {
      const starting = manager.startWorker(pluginId, { ...startOptions(), env: { SPS_TEST_INITIALIZE_DELAY_MS: "100" } });
      await expect(manager.artifactMaintenance!.withMaintenance(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      await starting;
      await manager.artifactMaintenance!.withMaintenance(async () => {
        expect(manager.getWorker(pluginId)?.status).toBe("running");
      });
    } finally { await manager.shutdown(); }
  });
});
