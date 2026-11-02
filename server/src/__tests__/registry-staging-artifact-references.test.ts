import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateRegistryCapabilitiesDigest } from "../services/registry-static-manifest.js";
import { registryStagingService, type RegistryStagedPluginRecord } from "../services/registry-staging.js";

const ownedRoots: Array<{ root: string; parent: string; identity: BigIntStats; sentinel: string }> = [];
const originalOpen = fs.open;
const execFileAsync = promisify(execFile);
const pluginRecordId = "11111111-1111-4111-8111-111111111111";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owned of ownedRoots.splice(0)) {
    expect(await fs.readFile(owned.sentinel, "utf8")).toBe("external synthetic data must stay");
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.parent
      && path.basename(owned.root).startsWith("sps-registry-refs-")).toBe(true);
    expect(await fs.realpath(owned.root)).toBe(owned.root);
    const current = await fs.lstat(owned.root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(current[key]).toBe(owned.identity[key]);
    await fs.rm(owned.root, { recursive: true, force: false });
  }
});

async function fixture(createRoot = true) {
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, "sps-registry-refs-"));
  const identity = await fs.lstat(owned, { bigint: true });
  const sentinel = path.join(owned, "external-keep.txt");
  await fs.writeFile(sentinel, "external synthetic data must stay");
  ownedRoots.push({ root: owned, parent, identity, sentinel });
  const root = path.join(owned, "registry");
  if (createRoot) await fs.mkdir(root);
  const index = path.join(root, "registry-stages.json");
  const service = registryStagingService(root);
  async function stage(suffix = "one") {
    const packageRoot = path.join(root, "packages", suffix);
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    const runtime = "throw new Error('this fixture must never execute');\n";
    const capabilities = ["agent.tools.register"];
    await fs.writeFile(path.join(packageRoot, "dist", "manifest.js"), runtime);
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: `@test/${suffix}`, version: "1.2.3" }));
    await fs.writeFile(path.join(packageRoot, "sps-plugin.json"), JSON.stringify({
      schemaVersion: 1,
      plugin: { id: `test.registry.${suffix}`, version: "1.2.3", apiVersion: "1" },
      runtime: { manifestEntry: "dist/manifest.js", manifestSha256: createHash("sha256").update(runtime).digest("hex") },
      capabilities, permissionsDigest: calculateRegistryCapabilitiesDigest(capabilities),
    }));
    return service.stage({ packageRoot, artifactSha256: "a".repeat(64),
      source: { registryId: "test.registry", kind: "local", releaseLocator: `releases/${suffix}.json` } });
  }
  return { root, owned, index, service, stage, sentinel };
}
const writerText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const reviewFor = (record: RegistryStagedPluginRecord) => ({
  pluginRecordId, targetVersion: record.version, addedCapabilities: ["agent.tools.register"],
  migrationPlan: {
    pluginId: pluginRecordId, pluginKey: record.pluginId, targetVersion: record.version,
    namespaceName: "plugin_test", hasAppliedMigrations: true, requiresHostApproval: true,
    reviewHash: "b".repeat(64), pendingMigrations: [{ migrationKey: "001.sql", checksum: "c".repeat(64),
      statementCount: 1, operationKinds: ["alter" as const] }],
  },
});

describe("Host-private Registry stage artifact references", () => {
  it.each([false, true])("returns empty only for genuinely missing index without mkdir (root exists: %s)", async exists => {
    const { root, service } = await fixture(exists);
    const mkdir = vi.spyOn(fs, "mkdir");
    expect(await service.readArtifactReferences()).toEqual([]);
    expect(mkdir).not.toHaveBeenCalled();
    if (exists) expect(await fs.readdir(root)).toEqual([]);
    else await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves staged, review_pending and registered roots as immutable data without executing code", async () => {
    const { index, service, stage } = await fixture();
    const staged = await stage("staged");
    const pending = await stage("pending");
    const registered = await stage("registered");
    await service.markReviewPending(pending.stageId, reviewFor(pending));
    await service.markRegistered(registered.stageId);
    const before = await fs.readFile(index);
    const result = await service.readArtifactReferences();
    expect(result).toEqual([staged, { ...pending, status: "review_pending" }, { ...registered, status: "registered" }]
      .map(({ stageId, pluginId, status, packageRoot }) => ({ stageId, pluginId, status, packageRoot })));
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(() => { (result[0] as { packageRoot: string }).packageRoot = "changed"; }).toThrow();
    expect(await fs.readFile(index)).toEqual(before);
    expect(await fs.readFile(path.join(staged.packageRoot, "dist", "manifest.js"), "utf8")).toContain("must never execute");
    expect(await service.list()).toHaveLength(3);
  });

  it.each(["lf", "crlf", "bom", "no-final-newline"])("accepts the current writer spelling with %s", async spelling => {
    const { index, service, stage } = await fixture();
    const record = await stage();
    let text = writerText([record]);
    if (spelling === "crlf") text = text.replace(/\n/g, "\r\n");
    if (spelling === "bom") text = `\uFEFF${text}`;
    if (spelling === "no-final-newline") text = text.slice(0, -1);
    await fs.writeFile(index, text);
    expect(await service.readArtifactReferences()).toHaveLength(1);
    expect(await fs.readFile(index, "utf8")).toBe(text);
  });

  it("keeps a missing managed package path instead of silently dropping its protection reference", async () => {
    const { service, stage } = await fixture();
    const record = await stage();
    await fs.rename(record.packageRoot, `${record.packageRoot}.preserved`);
    expect(await service.readArtifactReferences()).toEqual([
      { stageId: record.stageId, pluginId: record.pluginId, status: "staged", packageRoot: record.packageRoot },
    ]);
  });

  it.skipIf(process.platform !== "win32")("reads a real mixed-case storage alias without changing the index or adopting links", async () => {
    const { root, index, service, stage } = await fixture();
    const record = await stage();
    const alias = path.join(path.dirname(root), "ReGiStRy");
    const original = await fs.lstat(root, { bigint: true });
    const aliased = await fs.lstat(alias, { bigint: true });
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(aliased[key]).toBe(original[key]);
    expect(aliased.isSymbolicLink()).toBe(false);
    expect(await fs.realpath(alias)).not.toBe(alias);
    const bytes = await fs.readFile(index);
    expect(await registryStagingService(alias).readArtifactReferences()).toEqual(await service.readArtifactReferences());
    expect((await service.readArtifactReferences())[0]!.packageRoot).toBe(record.packageRoot);
    expect(await fs.readFile(index)).toEqual(bytes);

    const missingStorage = path.join(alias, "missing", "stages");
    expect(await registryStagingService(missingStorage).readArtifactReferences()).toEqual([]);
    await expect(fs.lstat(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32")("derives a missing package descendant from its real mixed-case parent", async () => {
    const { root, index, service, stage } = await fixture();
    const record = await stage();
    const packageRoot = path.join(path.dirname(root), "ReGiStRy", "packages", "missing", "descendant");
    await fs.writeFile(index, writerText([{ ...record, packageRoot }]));
    expect(await service.readArtifactReferences()).toEqual([
      { stageId: record.stageId, pluginId: record.pluginId, status: "staged", packageRoot },
    ]);
    await expect(fs.lstat(path.join(root, "packages", "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32")("reads an actual 8.3 storage alias when the filesystem provides one", async context => {
    const { root, index, service, stage } = await fixture();
    await stage();
    // The fixed cmd expansion only queries this owned path. Reject shell
    // metacharacters rather than accepting arbitrary command input from TEMP.
    if (/[%!^&|<>"()\r\n]/.test(root)) {
      context.skip("Owned temp path is unsuitable for the fixed read-only short-name query.");
      return;
    }
    const command = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    const { stdout } = await execFileAsync(command, ["/d", "/c", `for %I in ("${root}") do @echo %~sI`],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const alias = stdout.trim();
    if (alias === root || !alias.split(/[\\/]/).some(part => /~[0-9]/.test(part))) {
      context.skip("This filesystem does not provide an 8.3 alias for the owned fixture.");
      return;
    }
    const original = await fs.lstat(root, { bigint: true });
    const aliased = await fs.lstat(alias, { bigint: true });
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(aliased[key]).toBe(original[key]);
    expect(aliased.isSymbolicLink()).toBe(false);
    expect(await fs.realpath(alias)).not.toBe(alias);
    const bytes = await fs.readFile(index);
    expect(await registryStagingService(alias).readArtifactReferences()).toEqual(await service.readArtifactReferences());
    expect(await fs.readFile(index)).toEqual(bytes);
  });

  it.each([
    ["unknown record key", (record: RegistryStagedPluginRecord) => ({ ...record, hiddenRoot: "/unknown" })],
    ["unknown source key", (record: RegistryStagedPluginRecord) => ({ ...record, source: { ...record.source, hiddenRoot: "/unknown" } })],
    ["unknown static key", (record: RegistryStagedPluginRecord) => ({ ...record, staticManifest: { ...record.staticManifest, hidden: true } })],
    ["wrong plugin identity", (record: RegistryStagedPluginRecord) => ({ ...record, pluginId: "test.wrong.identity" })],
    ["wrong stage identity", (record: RegistryStagedPluginRecord) => ({ ...record, stageId: "0".repeat(32) })],
    ["wrong static digest", (record: RegistryStagedPluginRecord) => ({ ...record, staticManifest: { ...record.staticManifest, permissionsDigest: "0".repeat(64) } })],
    ["overlong text", (record: RegistryStagedPluginRecord) => ({ ...record, packageName: "x".repeat(257) })],
    ["relative root", (record: RegistryStagedPluginRecord) => ({ ...record, packageRoot: "packages/one" })],
    ["unmanaged root", (record: RegistryStagedPluginRecord) => ({ ...record, packageRoot: path.dirname(path.dirname(record.packageRoot)) })],
    ["noncanonical root", (record: RegistryStagedPluginRecord) => ({ ...record, packageRoot: `${record.packageRoot}${path.sep}..${path.sep}one` })],
    ["control in root", (record: RegistryStagedPluginRecord) => ({ ...record, packageRoot: `${record.packageRoot}\0` })],
    ["unsupported status", (record: RegistryStagedPluginRecord) => ({ ...record, status: "deleted" })],
    ["pending without review", (record: RegistryStagedPluginRecord) => ({ ...record, status: "review_pending" })],
    ["staged with review", (record: RegistryStagedPluginRecord) => ({ ...record, review: { ...reviewFor(record), requestedAt: record.stagedAt } })],
    ["registered with review", (record: RegistryStagedPluginRecord) => ({ ...record, status: "registered", review: { ...reviewFor(record), requestedAt: record.stagedAt } })],
    ["unknown review key", (record: RegistryStagedPluginRecord) => ({ ...record, status: "review_pending", review: { ...reviewFor(record), requestedAt: record.stagedAt, hidden: true } })],
    ["wrong review version", (record: RegistryStagedPluginRecord) => ({ ...record, status: "review_pending", review: { ...reviewFor(record), targetVersion: "2.0.0", requestedAt: record.stagedAt } })],
    ["wrong migration owner", (record: RegistryStagedPluginRecord) => ({ ...record, status: "review_pending", review: {
      ...reviewFor(record), requestedAt: record.stagedAt, migrationPlan: { ...reviewFor(record).migrationPlan, pluginId: "22222222-2222-4222-8222-222222222222" },
    } })],
  ])("rejects the entire index for %s without returning a partial list", async (_name, invalid) => {
    const { index, service, stage } = await fixture();
    const first = await stage("first");
    const second = await stage("second");
    const text = writerText([first, invalid(second)]);
    await fs.writeFile(index, text);
    await expect(service.readArtifactReferences()).rejects.toThrow("references are unavailable");
    expect(await fs.readFile(index, "utf8")).toBe(text);
  });

  it.each(["duplicate stage ID", "too many records", "not an array", "malformed JSON", "compact JSON", "duplicate key", "escaped duplicate key", "invalid UTF-8"])(
    "rejects %s rather than ignoring hidden records", async kind => {
      const { index, service, stage } = await fixture();
      const record = await stage();
      let bytes: string | Buffer = writerText([record]);
      if (kind === "duplicate stage ID") bytes = writerText([record, record]);
      if (kind === "too many records") bytes = writerText(Array.from({ length: 10_001 }, () => null));
      if (kind === "not an array") bytes = writerText({ records: [record] });
      if (kind === "malformed JSON") bytes = "[";
      if (kind === "compact JSON") bytes = JSON.stringify([record]);
      if (kind === "duplicate key" || kind === "escaped duplicate key") {
        const key = kind === "duplicate key" ? "packageRoot" : "package\\u0052oot";
        bytes = bytes.replace('    "packageRoot":', `    "${key}": "/hidden-root",\n    "packageRoot":`);
      }
      if (kind === "invalid UTF-8") bytes = Buffer.from([0xff]);
      await fs.writeFile(index, bytes);
      await expect(service.readArtifactReferences()).rejects.toThrow("references are unavailable");
      expect(await fs.readFile(index)).toEqual(Buffer.from(bytes));
    },
  );

  it.each(["directory", "symlink", "hardlink", "oversized"])("rejects a %s index without touching external data", async kind => {
    const { index, root, service, sentinel } = await fixture();
    if (kind === "directory") await fs.mkdir(index);
    else if (kind === "symlink") await fs.symlink(sentinel, index, "file");
    else if (kind === "hardlink") await fs.link(sentinel, index);
    else {
      const handle = await originalOpen(index, "wx");
      try { await handle.truncate(8 * 1024 * 1024 + 1); } finally { await handle.close(); }
    }
    await expect(service.readArtifactReferences()).rejects.toThrow("references are unavailable");
    expect(await fs.readdir(root)).toContain("registry-stages.json");
  });

  it.each(["storage", "package", "package ancestor", "dangling storage"])("rejects a linked %s without following or adopting it", async kind => {
    const { root, index, owned, service, stage } = await fixture();
    const record = await stage();
    const source = kind === "package" ? record.packageRoot : kind === "package ancestor" ? path.dirname(record.packageRoot) : root;
    const preserved = `${source}.preserved`;
    await fs.rename(source, preserved);
    await fs.symlink(kind === "dangling storage" ? path.join(owned, "missing-target") : preserved,
      source, process.platform === "win32" ? "junction" : "dir");
    await expect(service.readArtifactReferences()).rejects.toThrow("references are unavailable");
    if (kind === "storage" || kind === "dangling storage") {
      expect(await fs.readFile(path.join(preserved, path.basename(index)), "utf8")).toContain(record.stageId);
    }
  });

  it.each(["index replacement", "membership rewrite", "storage replacement", "index disappears", "permission failure"])(
    "rejects %s during the handle-based read", async kind => {
      const { root, index, service, stage } = await fixture();
      const record = await stage();
      const bytes = await fs.readFile(index);
      vi.spyOn(fs, "open").mockImplementationOnce(async (file, flags, mode) => {
        if (kind === "permission failure") throw Object.assign(new Error("private fixture failure"), { code: "EACCES" });
        const handle = await originalOpen(file, flags, mode);
        if (kind === "index replacement") {
          await fs.rename(index, `${index}.preserved`);
          await fs.writeFile(index, bytes);
        } else if (kind === "membership rewrite") await fs.writeFile(index, writerText([]));
        else if (kind === "storage replacement") {
          await fs.rename(root, `${root}.preserved`);
          await fs.mkdir(root);
          await fs.rename(path.join(`${root}.preserved`, path.basename(index)), index);
        } else await fs.rename(index, `${index}.preserved`);
        return handle;
      });
      await expect(service.readArtifactReferences()).rejects.toThrow("references are unavailable");
      const preserved = kind === "index replacement" || kind === "index disappears" ? `${index}.preserved` : index;
      if (kind !== "membership rewrite") expect(await fs.readFile(preserved, "utf8")).toContain(record.stageId);
    },
  );
});
