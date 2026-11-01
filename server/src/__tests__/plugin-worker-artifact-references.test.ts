import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";

const fixture = fileURLToPath(new URL("./fixtures/plugin-worker-shutdown.cjs", import.meta.url));
const pluginId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const manifest: PaperclipPluginManifestV1 = {
  id: "test.artifact-reference", apiVersion: 1, version: "1.0.0", displayName: "Artifact reference fixture",
  description: "Owned test worker", author: "SPS", categories: ["automation"], capabilities: [],
  entrypoints: { worker: "worker.cjs" },
};
const options = (): WorkerStartOptions => ({
  entrypointPath: fixture, manifest, config: { privateFixture: "not-reference-data" },
  instanceInfo: { instanceId: "artifact-reference-test", hostVersion: "1" },
  apiVersion: 1, hostHandlers: {}, autoRestart: false,
});

describe("Host-private Worker artifact references", () => {
  it("records an admitted start before initialize and freezes only private reference data", async () => {
    const manager = createPluginWorkerManager();
    try {
      expect(manager.readArtifactReferences!()).toEqual([]);
      const starting = manager.startWorker(pluginId, options());
      const initial = manager.readArtifactReferences!();
      expect(initial).toHaveLength(1);
      expect(initial[0]).toMatchObject({ pluginId, workspaceId: null, entrypointPath: fixture, starting: true });
      expect(initial[0]!.ownerId).toMatch(/^[a-f0-9-]{36}$/);
      expect(Object.isFrozen(initial)).toBe(true);
      expect(Object.isFrozen(initial[0])).toBe(true);
      expect(Object.keys(initial[0]!).sort()).toEqual([
        "entrypointPath", "ownerId", "pluginId", "starting", "status", "workspaceId",
      ]);
      expect(JSON.stringify(initial)).not.toMatch(/not-reference-data|"pid"|"config"|"env"/);
      expect(() => { (initial[0] as { entrypointPath: string }).entrypointPath = "changed"; }).toThrow();
      await starting;
      expect(manager.readArtifactReferences!()[0]).toMatchObject({ ownerId: initial[0]!.ownerId, starting: false, status: "running" });
      expect(JSON.stringify(manager.diagnostics())).not.toContain(fixture);
    } finally { await manager.shutdown(); }
    expect(() => manager.readArtifactReferences!()).toThrow(/shutdown/);
  });

  it("keeps the admitted launch path through caller mutation, stop and actual restart", async () => {
    const manager = createPluginWorkerManager();
    try {
      const input = options();
      const starting = manager.startWorker(pluginId, input);
      input.entrypointPath = path.join(path.dirname(fixture), "not-an-executable-fixture.cjs");
      const handle = await starting;
      const ownerId = manager.readArtifactReferences!()[0]!.ownerId;
      await handle.stop();
      expect(manager.readArtifactReferences!()).toEqual([
        { ownerId, pluginId, workspaceId: null, entrypointPath: fixture, starting: false, status: "stopped" },
      ]);
      await handle.start();
      await handle.restart();
      expect(manager.readArtifactReferences!()[0]).toMatchObject({ ownerId, entrypointPath: fixture, status: "running" });
      await manager.stopWorker(pluginId);
      expect(manager.readArtifactReferences!()).toEqual([]);
      await manager.startWorker(pluginId, options());
      expect(manager.readArtifactReferences!()[0]!.ownerId).not.toBe(ownerId);
    } finally { await manager.shutdown(); }
  });

  it("keeps Host and Workspace handles separate until each owned close confirms", async () => {
    const manager = createPluginWorkerManager();
    try {
      await manager.startWorker(pluginId, options());
      await manager.startWorkspaceWorker(workspaceId, pluginId, options());
      const references = manager.readArtifactReferences!();
      expect(references.map(row => row.workspaceId).sort()).toEqual([workspaceId, null].sort());
      expect(new Set(references.map(row => row.ownerId)).size).toBe(2);
      expect(references.every(row => row.entrypointPath === fixture && row.status === "running")).toBe(true);
      await manager.stopWorkspaceWorkers(workspaceId, pluginId);
      expect(manager.readArtifactReferences!()).toHaveLength(1);
      expect(manager.readArtifactReferences!()[0]!.workspaceId).toBeNull();
      await manager.stopWorker(pluginId);
      expect(manager.readArtifactReferences!()).toEqual([]);
    } finally { await manager.shutdown(); }
  });

  it("preserves non-path options behavior rather than freezing all caller options", async () => {
    const manager = createPluginWorkerManager();
    try {
      const input = options();
      const handle = await manager.startWorker(pluginId, input);
      await handle.stop();
      input.entrypointPath = path.join(path.dirname(fixture), "not-an-executable-fixture.cjs");
      input.env = { SPS_TEST_FAIL_INITIALIZE: "1" };
      await expect(handle.start()).rejects.toThrow(/initialize failed[\s\S]*returned ok=false/i);
      expect(manager.readArtifactReferences!()[0]!.entrypointPath).toBe(fixture);
    } finally { await manager.shutdown(); }
  });
});
