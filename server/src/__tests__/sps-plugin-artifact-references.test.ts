import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "../compat/paperclip/shared.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { createSpsPluginArtifactReferenceReader, type SpsPluginArtifactReferenceReaders,
  type SpsPluginArtifactReferenceScope } from "../services/sps-plugin-artifact-references.js";

const roots = new Set<string>();
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear(); });
const unavailable = { code: "SPS_PLUGIN_ARTIFACT_REFERENCES_UNAVAILABLE" };
function plugin(id: string, packagePath: string | null, status = "ready"): PluginRecord {
  return { id, pluginKey: `test.${id}`, packageName: `@test/${id}`, packagePath, version: "1.0.0", status,
    manifestJson: { entrypoints: { worker: "worker.js" } } } as PluginRecord;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sps-artifact-reference-scope-"));
  roots.add(root);
  const maintenance = createSpsPluginArtifactMaintenance();
  const state = { plugins: [] as PluginRecord[], pending: [] as any[], reviews: [] as any[], workers: [] as any[], preparations: [] as any[], stages: [] as any[] };
  const readers: SpsPluginArtifactReferenceReaders = {
    listPlugins: async () => state.plugins, listPending: async () => state.pending, listRetainedReviews: async () => state.reviews,
    readWorkers: () => state.workers,
    readPreparations: () => state.preparations, readRegistryStages: async () => state.stages,
  };
  const reader = createSpsPluginArtifactReferenceReader({ localPluginDir: root, maintenance, readers });
  return { root, maintenance, readers, state, reader };
}

describe("Core-only coherent artifact reference scopes", () => {
  it("joins every retained source, freezes private paths, rejects activity and expires the scope", async () => {
    const { root, maintenance, state, reader } = await fixture();
    state.plugins = ["ready", "disabled", "uninstalled", "upgrade_pending"].map((status, index) => plugin(`p${index}`, path.join(root, `p${index}`), status));
    const old = plugin("previous", path.join(root, "previous")), candidate = plugin("previous", path.join(root, "candidate"));
    state.pending = [{ id: "upgrade-intent", pluginId: old.id, pluginKey: old.pluginKey, kind: "upgrade", snapshot: old,
      candidate, phase: "activation_entered", backupFile: path.join(root, "backup.sql") }];
    state.reviews = [{ id: "completed-review", pluginId: old.id, pluginKey: old.pluginKey, snapshot: old,
      candidate, outcome: "review_required", backupFile: path.join(root, "review-backup.sql") }];
    state.workers = [{ ownerId: "owned-child", pluginId: old.id, workspaceId: "workspace", entrypointPath: path.join(root, "worker.js"), status: "stopped", starting: false }];
    state.preparations = [{ ownerId: "uncertain-prepare", pluginId: old.id, artifactRoot: path.join(root, "uncertain"), phase: "uncertain" }];
    state.stages = [{ stageId: "pending-review", pluginId: old.pluginKey, packageRoot: path.join(root, "review"), status: "review_pending" }];
    let retained!: SpsPluginArtifactReferenceScope;
    const output = Object.freeze({ preserved: true });
    expect(await reader.withSnapshot(async scope => {
      retained = scope;
      expect(scope.coverage).toBe("core-only");
      expect(scope.references.map(row => row.source).sort()).toEqual([
        "plugin", "plugin", "plugin", "plugin", "pending-previous", "pending-candidate", "pending-backup",
        "review-previous", "review-candidate", "review-backup", "worker", "preparation", "registry-stage",
      ].sort());
      expect(scope.references.filter(row => row.source === "plugin").map(row => row.state).sort())
        .toEqual(["disabled", "ready", "uninstalled", "upgrade_pending"]);
      expect(Object.isFrozen(scope) && Object.isFrozen(scope.references) && scope.references.every(Object.isFrozen)).toBe(true);
      expect(scope.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      await scope.assertCurrent();
      return output;
    })).toBe(output);
    await expect(retained.assertCurrent()).rejects.toMatchObject(unavailable);
    await maintenance.withActivity(async () => {});
    expect((retained as unknown as Record<string, unknown>).eligible).toBeUndefined();
  });

  it("protects both legacy package roots and absolute Worker fallback without choosing by existence", async () => {
    const { root, state, reader } = await fixture();
    const record = plugin("legacy", null, "uninstalled");
    record.manifestJson.entrypoints.worker = path.join(root, "absolute-worker.js");
    state.plugins = [record];
    await reader.withSnapshot(async scope => {
      expect(scope.references.map(row => row.path).sort()).toEqual([
        path.join(root, "node_modules", "@test", "legacy"), path.join(root, "@test", "legacy"), path.join(root, "absolute-worker.js"),
      ].sort());
    });
  });

  it("rejects unavailable or missing sources rather than returning a partial safe set", async () => {
    const { root, maintenance, readers } = await fixture();
    for (const key of Object.keys(readers) as Array<keyof SpsPluginArtifactReferenceReaders>) {
      for (const broken of [() => { throw new Error("private controlled source failure"); }, () => undefined]) {
        const observe = createSpsPluginArtifactReferenceReader({ localPluginDir: root, maintenance,
          readers: { ...readers, [key]: broken } as unknown as SpsPluginArtifactReferenceReaders });
        const action = vi.fn(async () => {});
        await expect(observe.withSnapshot(action)).rejects.toMatchObject(unavailable);
        expect(action).not.toHaveBeenCalled();
        await maintenance.withActivity(async () => {});
      }
    }
  });

  it("rejects malformed explicit paths, traversal package names and mismatched pending identity", async () => {
    const { root, state, reader } = await fixture();
    for (const malformed of ["", "relative", undefined]) {
      state.plugins = [{ ...plugin("bad", path.join(root, "package")), packagePath: malformed } as PluginRecord];
      await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject(unavailable);
    }
    state.plugins = [{ ...plugin("bad", null), packageName: "../outside" }];
    await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject(unavailable);
    state.plugins = [];
    state.pending = [{ id: "wrong", kind: "uninstall", pluginId: "different", pluginKey: "test.bad", snapshot: plugin("bad", root) }];
    await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject(unavailable);
  });

  it("detects a newly published reference before returning a successful observation", async () => {
    const { root, state, reader, maintenance } = await fixture();
    await expect(reader.withSnapshot(async () => { state.plugins.push(plugin("new", path.join(root, "new"))); }))
      .rejects.toMatchObject(unavailable);
    await maintenance.withActivity(async () => {});
  });

  it("binds an optional all-Workspace Source fingerprint and rejects changes or unavailable reads", async () => {
    const { readers, reader } = await fixture();
    let fingerprint = "a".repeat(64);
    readers.readSourceFingerprint = async () => fingerprint;
    let first = "";
    await reader.withSnapshot(async scope => { first = scope.fingerprint; });
    fingerprint = "b".repeat(64);
    await reader.withSnapshot(async scope => { expect(scope.fingerprint).not.toBe(first); });
    await expect(reader.withSnapshot(async () => { fingerprint = "c".repeat(64); })).rejects.toMatchObject(unavailable);
    for (const broken of [async () => "", async () => undefined, async () => { throw new Error("private DB details"); }]) {
      readers.readSourceFingerprint = broken as () => Promise<string>;
      const caller = vi.fn(async () => {});
      await expect(reader.withSnapshot(caller)).rejects.toMatchObject(unavailable);
      expect(caller).not.toHaveBeenCalled();
    }
  });

  it("detects missing paths appearing and an actual launch file replacement during a scope", async () => {
    const { root, state, reader } = await fixture();
    const worker = path.join(root, "worker.js");
    state.workers = [{ ownerId: "child", pluginId: "plugin", entrypointPath: worker, status: "running" }];
    await expect(reader.withSnapshot(async () => { await writeFile(worker, "throw new Error('must not import');"); }))
      .rejects.toMatchObject(unavailable);
    await expect(reader.withSnapshot(async scope => {
      await rename(worker, path.join(root, "retained-old-worker.js"));
      await writeFile(worker, "throw new Error('replacement must not import');");
      await scope.assertCurrent();
    })).rejects.toMatchObject(unavailable);
  });

  it("rejects duplicate owners from every source and excessive membership", async () => {
    const { root, state, reader } = await fixture();
    const examples = {
      plugins: plugin("p", root),
      pending: { id: "intent", kind: "uninstall", pluginId: "p", pluginKey: "test.p", snapshot: plugin("p", root) },
      reviews: { id: "review", pluginId: "p", pluginKey: "test.p", snapshot: plugin("p", root), candidate: plugin("p", root), outcome: "review_required", backupFile: null },
      workers: { ownerId: "worker", pluginId: "p", entrypointPath: path.join(root, "worker.js"), status: "stopped" },
      preparations: { ownerId: "prepare", pluginId: "p", artifactRoot: root, phase: "prepared" },
      stages: { stageId: "stage", pluginId: "test.p", packageRoot: root, status: "registered" },
    };
    for (const key of Object.keys(examples) as Array<keyof typeof examples>) {
      (state[key] as any[]) = [examples[key], examples[key]];
      await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject(unavailable);
      (state[key] as any[]) = [];
    }
    state.plugins = Array.from({ length: 60_001 }, () => examples.plugins);
    await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject(unavailable);
  });

  it("ignores source enumeration order but retains all references in deterministic order", async () => {
    const { root, state, reader } = await fixture();
    await mkdir(path.join(root, "existing"));
    state.plugins = [plugin("a", path.join(root, "existing")), plugin("b", path.join(root, "absent"))];
    let fingerprint = "";
    await reader.withSnapshot(async scope => {
      fingerprint = scope.fingerprint;
      state.plugins.reverse();
      await scope.assertCurrent();
    });
    await reader.withSnapshot(async scope => { expect(scope.fingerprint).toBe(fingerprint); });
  });

  it("preserves callback errors and rejects observations while an operation is admitted", async () => {
    const { maintenance, reader } = await fixture();
    const failure = new Error("original caller failure");
    await expect(reader.withSnapshot(async () => { throw failure; })).rejects.toBe(failure);
    await maintenance.withActivity(async () => {
      await expect(reader.withSnapshot(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    });
    await reader.withSnapshot(async () => {});
  });
});
