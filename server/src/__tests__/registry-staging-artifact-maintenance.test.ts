import { createHash } from "node:crypto";
import { promises as fs, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { calculateRegistryCapabilitiesDigest } from "../services/registry-static-manifest.js";
import { registryStagingService } from "../services/registry-staging.js";

const ownedRoots: Array<{ root: string; parent: string; identity: BigIntStats; sentinel: string }> = [];
const originalRename = fs.rename;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owned of ownedRoots.splice(0)) {
    expect(await fs.readFile(owned.sentinel, "utf8")).toBe("preserve external synthetic data");
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.parent
      && path.basename(owned.root).startsWith("sps-registry-maintenance-")).toBe(true);
    expect(await fs.realpath(owned.root)).toBe(owned.root);
    const current = await fs.lstat(owned.root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(current[key]).toBe(owned.identity[key]);
    await fs.rm(owned.root, { recursive: true, force: false });
  }
});

async function fixture(useMaintenance = true) {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, "sps-registry-maintenance-"));
  const identity = await fs.lstat(owned, { bigint: true });
  const sentinel = path.join(owned, "external-keep.txt");
  await fs.writeFile(sentinel, "preserve external synthetic data");
  ownedRoots.push({ root: owned, parent, identity, sentinel });
  const root = path.join(owned, "registry");
  const packageRoot = path.join(root, "packages", "inert");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  const runtime = "throw new Error('maintenance fixture must never execute');\n";
  await fs.writeFile(path.join(packageRoot, "dist", "manifest.js"), runtime);
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@test/maintenance", version: "1.2.3" }));
  await fs.writeFile(path.join(packageRoot, "sps-plugin.json"), JSON.stringify({
    schemaVersion: 1, plugin: { id: "test.registry.maintenance", version: "1.2.3", apiVersion: "1" },
    runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(runtime).digest("hex") },
    capabilities: [], permissionsDigest: calculateRegistryCapabilitiesDigest([]),
  }));
  const maintenance = createSpsPluginArtifactMaintenance();
  const service = registryStagingService(root, useMaintenance ? maintenance : undefined);
  const input = { packageRoot, artifactSha256: "a".repeat(64),
    source: { registryId: "test.registry", kind: "local" as const, releaseLocator: "releases/inert.json" } };
  const record = await service.stage(input);
  const review = { pluginRecordId: "11111111-1111-4111-8111-111111111111", targetVersion: "1.2.3",
    addedCapabilities: [], migrationPlan: null };
  const writers = {
    stage: () => service.stage(input),
    remove: () => service.remove(record.stageId),
    markReviewPending: () => service.markReviewPending(record.stageId, review),
    markRegistered: () => service.markRegistered(record.stageId),
  };
  return { root, index: path.join(root, "registry-stages.json"), service, maintenance, input, record, review, writers };
}

const writerNames = ["stage", "remove", "markReviewPending", "markRegistered"] as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Registry stage artifact maintenance admission", () => {
  it("rejects every writer before validation or filesystem IO during maintenance while all reads remain available", async () => {
    const { service, maintenance, writers, input, record, review, index } = await fixture();
    await service.markReviewPending(record.stageId, review);
    const before = await fs.readFile(index);
    const io = [vi.spyOn(fs, "readFile"), vi.spyOn(fs, "mkdir"), vi.spyOn(fs, "lstat"), vi.spyOn(fs, "realpath"),
      vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "rename"), vi.spyOn(fs, "open")];
    const validation = vi.fn(() => { throw new Error("validation must not run"); });
    const guardedInput = { ...input, get artifactSha256(): string { return validation(); } };
    try {
      await maintenance.withMaintenance(async () => {
        await expect(service.stage(guardedInput)).rejects.toThrow(/maintenance|busy/i);
        for (const name of writerNames) await expect(writers[name]()).rejects.toThrow(/maintenance|busy/i);
        expect(validation).not.toHaveBeenCalled();
        for (const call of io) expect(call).not.toHaveBeenCalled();
        expect(await service.list()).toHaveLength(1);
        expect(await service.get(record.stageId)).toMatchObject({ status: "review_pending" });
        expect(await service.findPendingReview(review.pluginRecordId)).toMatchObject({ stageId: record.stageId });
        expect(await service.readArtifactReferences()).toEqual([
          { stageId: record.stageId, pluginId: record.pluginId, status: "review_pending", packageRoot: record.packageRoot },
        ]);
      });
    } finally { vi.restoreAllMocks(); }
    expect(await fs.readFile(index)).toEqual(before);
    await expect(service.markRegistered(record.stageId)).resolves.toMatchObject({ status: "registered" });
  });

  it.each(writerNames)("keeps %s active through the actual final index rename and releases after it settles", async name => {
    const { index, service, maintenance, writers } = await fixture();
    const finishRename = deferred();
    let renamed = false;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
      await originalRename(source, target);
      renamed = true;
      await finishRename.promise;
    });
    const writing = writers[name]();
    try {
      await vi.waitFor(() => expect(renamed).toBe(true));
      const attempted = vi.fn(async () => "maintenance-entered");
      await expect(maintenance.withMaintenance(attempted)).rejects.toThrow(/maintenance|busy/i);
      expect(attempted).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(index, "utf8"))).toBeInstanceOf(Array);
    } finally { finishRename.resolve(); }
    await writing;
    vi.restoreAllMocks();
    await expect(maintenance.withMaintenance(async () => service.readArtifactReferences())).resolves.toHaveLength(name === "remove" ? 0 : 1);
  });

  it.each(writerNames)("releases %s activity after final write failure without masking the failure or removing data", async name => {
    const { index, maintenance, writers } = await fixture();
    const before = await fs.readFile(index);
    const failure = new Error("controlled index publication failure");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    await expect(writers[name]()).rejects.toBe(failure);
    vi.restoreAllMocks();
    await expect(maintenance.withMaintenance(async () => "available")).resolves.toBe("available");
    expect(await fs.readFile(index)).toEqual(before);
  });

  it("holds activity before the first index read and releases an early read failure", async () => {
    const { service, maintenance, record } = await fixture();
    const originalRead = fs.readFile;
    const finishRead = deferred();
    let reading = false;
    vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      reading = true;
      await finishRead.promise;
      return originalRead(...args);
    });
    const writing = service.markRegistered(record.stageId);
    try {
      expect(reading).toBe(true);
      await expect(maintenance.withMaintenance(async () => undefined)).rejects.toThrow(/maintenance|busy/i);
    } finally { finishRead.resolve(); }
    await writing;
    vi.restoreAllMocks();
    const failure = new Error("controlled index read failure");
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
    await expect(service.remove(record.stageId)).rejects.toBe(failure);
    vi.restoreAllMocks();
    await expect(maintenance.withMaintenance(async () => service.list())).resolves.toHaveLength(1);
  });

  it("releases activity after synchronous stage validation and no-op writer results", async () => {
    const { service, maintenance, input, review } = await fixture();
    await expect(service.stage({ ...input, artifactSha256: "invalid" })).rejects.toThrow(/SHA-256/);
    expect(await service.remove("missing")).toBe(false);
    expect(await service.markReviewPending("missing", review)).toBeNull();
    expect(await service.markRegistered("missing")).toBeNull();
    await expect(maintenance.withMaintenance(async () => service.list())).resolves.toHaveLength(1);
  });

  it("keeps ordinary writer semantics without an optional maintenance coordinator", async () => {
    const { service, record, review, input } = await fixture(false);
    await expect(service.markReviewPending(record.stageId, review)).resolves.toMatchObject({ status: "review_pending" });
    await expect(service.markRegistered(record.stageId)).resolves.toMatchObject({ status: "registered" });
    await expect(service.stage(input)).resolves.toMatchObject({ stageId: record.stageId, status: "staged", review: null });
    await expect(service.remove(record.stageId)).resolves.toBe(true);
    expect(await service.list()).toEqual([]);
  });
});
