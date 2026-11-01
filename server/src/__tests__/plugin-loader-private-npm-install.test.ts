import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const registry = vi.hoisted(() => ({
  getById: vi.fn(),
  install: vi.fn(),
  listInstalled: vi.fn(),
  update: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLoader, resolvePluginPackageRoot, requiresSharedPluginArtifactCleanup } from "../services/plugin-loader.js";
import { withPluginPackageMutationPermit } from "../services/sps-plugin-package-maintenance.js";
import type { SpsPluginPackageOperations } from "../services/sps-plugin-package-operations.js";
import { createSpsPluginArtifactOwnership } from "../services/sps-plugin-artifact-ownership.js";

const pluginId = "a7f19aec-4724-4bca-9ddf-7358b5bdbdd1";
const activeManifest = {
  id: "sps.private-npm-upgrade",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Private npm install fixture",
  description: "A controlled package loader fixture.",
  author: "SPS",
  categories: ["automation"],
  capabilities: ["companies.read"],
  entrypoints: { worker: "./dist/worker.js" },
};

async function writeFakePackage(prefix: string, packageName: string, version: string, invalid = false, capabilities = activeManifest.capabilities): Promise<string> {
  const packageRoot = path.join(prefix, "node_modules", ...packageName.split("/"));
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version,
    type: "module",
    spsPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
  }), "utf8");
  const manifest = invalid
    ? { ...activeManifest, id: "not a valid plugin key", version }
    : { ...activeManifest, id: packageName === "@sps/private-npm-upgrade" ? activeManifest.id : `sps.${packageName.split("/").at(-1)}`, version, capabilities };
  await writeFile(path.join(packageRoot, "dist", "manifest.js"), `export default ${JSON.stringify(manifest)};\n`, "utf8");
  await writeFile(path.join(packageRoot, "dist", "worker.js"), `export const version = ${JSON.stringify(version)};\n`, "utf8");
  await writeFile(path.join(packageRoot, "artifact-marker.txt"), `${packageName}@${version}`, "utf8");
  return packageRoot;
}

function createNpmRunner() {
  const installed: Array<{ prefix: string; packageName: string; version: string; packageRoot: string }> = [];
  execFileMock.mockImplementation((...args: unknown[]) => {
    const commandArgs = args[1] as string[];
    const callback = args[3] as (error: Error | null, stdout?: string, stderr?: string) => void;
    const spec = commandArgs[1]!;
    const separator = spec.lastIndexOf("@");
    const packageName = spec.startsWith("@") && separator > 0 ? spec.slice(0, separator) : spec;
    const version = spec.startsWith("@") && separator > 0 ? spec.slice(separator + 1) : "1.0.0";
    const prefix = commandArgs[commandArgs.indexOf("--prefix") + 1]!;
    void writeFakePackage(prefix, packageName, version).then((packageRoot) => {
      installed.push({ prefix, packageName, version, packageRoot });
      callback(null, "", "");
    }, (error: unknown) => callback(error instanceof Error ? error : new Error("fake npm failed")));
    return {};
  });
  return installed;
}

describe("pluginLoader private npm artifacts", () => {
  const cleanupRoots = new Set<string>();
  let root = "";
  let localPluginDir = "";
  let db: { transaction: ReturnType<typeof vi.fn> };
  let installedRows: Array<Record<string, unknown>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(os.tmpdir(), "sps-private-npm-loader-"));
    cleanupRoots.add(root);
    localPluginDir = path.join(root, "managed-plugins");
    await mkdir(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a"), { recursive: true });
    await writeFile(path.join(localPluginDir, "package.json"), "{\"name\":\"active-root\"}\n", "utf8");
    await writeFile(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "root-active-copy", "utf8");
    installedRows = [];
    registry.install.mockImplementation(async (input: Record<string, unknown>, manifest: Record<string, unknown>) => {
      installedRows.push({ input, manifest });
      return { id: pluginId };
    });
    registry.listInstalled.mockResolvedValue([]);
    registry.update.mockResolvedValue(undefined);
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: null,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => await callback({})),
    };
  });

  afterEach(async () => {
    for (const cleanupRoot of cleanupRoots) await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoots.clear();
  });

  function createLoader(workspaceRuntime?: { withCatalogMutation: (action: () => Promise<unknown>) => Promise<unknown> },
    packageOperations?: SpsPluginPackageOperations) {
    const runtimeServices = { instanceInfo: { hostVersion: "1.0.0" }, ...(workspaceRuntime ? { workspaceRuntime } : {}) };
    return pluginLoader(db as never, {
      localPluginDir,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      packageOperations,
    }, runtimeServices as never);
  }

  it("rejects reinstall of a key with pending removal before registry commit and cleans only its new stage", async () => {
    const installed = createNpmRunner();
    const assertClear = vi.fn(async () => { throw new Error("package removal recovery required"); });
    const loader = createLoader(undefined, { assertClear } as unknown as SpsPluginPackageOperations);
    await expect(loader.installPlugin({ packageName: "@sps/private-npm-pending" }))
      .rejects.toThrow("package removal recovery required");
    expect(assertClear).toHaveBeenCalledWith(undefined, "sps.private-npm-pending");
    expect(registry.install).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(installed).toHaveLength(1);
    expect(await readdir(path.join(localPluginDir, ".install-staging"))).toEqual([]);
    expect(await readFile(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "utf8"))
      .toBe("root-active-copy");
  });

  it("rejects preparation and prepared commit while removal recovery is pending", async () => {
    const assertClear = vi.fn(async () => { throw new Error("package removal recovery required"); });
    const loader = createLoader(undefined, { assertClear } as unknown as SpsPluginPackageOperations);
    await expect(loader.prepareUpgrade(pluginId, { version: "2.0.0" })).rejects.toThrow("package removal recovery required");
    await expect(loader.commitPreparedUpgrade(pluginId, {} as never)).rejects.toThrow("package removal recovery required");
    expect(assertClear).toHaveBeenCalledTimes(2);
    expect(registry.update).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(loader.readPreparedArtifactReferences!()).toEqual([]);
  });

  it("retains an immutable preparation reference before allocation and through returned candidate inspection", async () => {
    const installed = createNpmRunner();
    const loader = createLoader();
    expect(loader.readPreparedArtifactReferences!()).toEqual([]);
    const preparing = loader.prepareUpgrade(pluginId, { version: "2.0.0" });
    expect(() => loader.readPreparedArtifactReferences!()).toThrow("references are unavailable");
    const prepared = await preparing;
    const references = loader.readPreparedArtifactReferences!();
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ pluginId, artifactRoot: installed[0]!.prefix, phase: "prepared" });
    expect(references[0]!.ownerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(references)).toBe(true);
    expect(Object.isFrozen(references[0])).toBe(true);
    const originalPath = prepared.discovered.packagePath;
    prepared.discovered.packagePath = path.join(root, "different-input");
    expect(loader.readPreparedArtifactReferences!()).toEqual(references);
    expect(await readFile(path.join(originalPath, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-upgrade@2.0.0");
  });

  it("retains the actual commit input until acknowledgement and hands the original preparation to the registry", async () => {
    createNpmRunner();
    const loader = createLoader();
    const prepared = await loader.prepareUpgrade(pluginId, { version: "2.0.0" });
    let acknowledge!: () => void;
    registry.update.mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const committing = loader.commitPreparedUpgrade(pluginId, { ...prepared });
    await vi.waitFor(() => expect(registry.update).toHaveBeenCalledOnce());
    const references = loader.readPreparedArtifactReferences!();
    expect(references.map(reference => reference.phase).sort()).toEqual(["committing", "prepared"]);
    expect(references.some(reference => reference.artifactRoot === prepared.discovered.packagePath)).toBe(true);
    acknowledge();
    await committing;
    expect(loader.readPreparedArtifactReferences!()).toEqual([]);
  });

  it("keeps both original and changed actual commit paths after a lost write response", async () => {
    createNpmRunner();
    const loader = createLoader();
    const prepared = await loader.prepareUpgrade(pluginId, { version: "2.0.0" });
    const original = loader.readPreparedArtifactReferences!()[0]!;
    const attempted = path.join(root, "different-input");
    prepared.discovered.packagePath = attempted;
    registry.update.mockRejectedValueOnce(new Error("commit response lost"));
    await expect(loader.commitPreparedUpgrade(pluginId, prepared)).rejects.toThrow("commit response lost");
    const references = loader.readPreparedArtifactReferences!();
    expect(references).toHaveLength(2);
    expect(references).toContainEqual({ ...original, phase: "uncertain" });
    expect(references.some(reference => reference.artifactRoot === attempted && reference.phase === "uncertain")).toBe(true);
    expect(await readFile(path.join(original.artifactRoot, "node_modules", "@sps", "private-npm-upgrade", "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-upgrade@2.0.0");
  });

  it("releases only its own known-rejected preparation after actual stage cleanup", async () => {
    createNpmRunner();
    const loader = createLoader();
    const retained = await loader.prepareUpgrade(pluginId, { version: "2.0.0" });
    const original = loader.readPreparedArtifactReferences!();
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null) => void;
      callback(new Error("controlled npm failure"));
      return {};
    });
    await expect(loader.prepareUpgrade(pluginId, { version: "3.0.0" })).rejects.toThrow("controlled npm failure");
    expect(loader.readPreparedArtifactReferences!()).toEqual(original);
    expect(await readFile(path.join(retained.discovered.packagePath, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-upgrade@2.0.0");
    expect(await readdir(path.dirname(original[0]!.artifactRoot))).toEqual([path.basename(original[0]!.artifactRoot)]);
  });

  it.each(["acknowledged", "lost response"])("keeps commit ownership captured when the caller swaps candidates before %s", async outcome => {
    createNpmRunner();
    const loader = createLoader();
    const first = await loader.prepareUpgrade(pluginId, { version: "2.0.0" });
    const firstPath = first.discovered.packagePath;
    const second = await loader.prepareUpgrade(pluginId, { version: "3.0.0" });
    const before = loader.readPreparedArtifactReferences!();
    const firstReference = before.find(reference => firstPath.startsWith(`${reference.artifactRoot}${path.sep}`))!;
    const secondReference = before.find(reference => second.discovered.packagePath.startsWith(`${reference.artifactRoot}${path.sep}`))!;
    let acknowledge!: () => void;
    let reject!: (error: Error) => void;
    registry.update.mockImplementationOnce(() => new Promise<void>((resolve, rejectPromise) => {
      acknowledge = resolve; reject = rejectPromise;
    }));
    const committing = loader.commitPreparedUpgrade(pluginId, first);
    const expected = outcome === "lost response" ? assertRejected() : committing;
    async function assertRejected() { await expect(committing).rejects.toThrow("commit reply lost"); }
    await vi.waitFor(() => expect(registry.update).toHaveBeenCalledOnce());
    first.discovered = second.discovered;
    expect(registry.update.mock.calls[0]![1]).toMatchObject({ packagePath: firstPath, version: "2.0.0" });
    if (outcome === "lost response") reject(new Error("commit reply lost"));
    else acknowledge();
    await expected;
    const after = loader.readPreparedArtifactReferences!();
    expect(after).toContainEqual(secondReference);
    if (outcome === "acknowledged") expect(after).toEqual([secondReference]);
    else {
      expect(after).toHaveLength(3);
      expect(after).toContainEqual({ ...firstReference, phase: "uncertain" });
      expect(after.some(reference => reference.artifactRoot === firstPath && reference.phase === "uncertain")).toBe(true);
    }
    expect(await readFile(path.join(second.discovered.packagePath, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-upgrade@3.0.0");
  });

  it("installs separate npm packages under immutable UUID-owned prefixes and persists exact paths", async () => {
    const installed = createNpmRunner();
    const rootPackageJson = await readFile(path.join(localPluginDir, "package.json"), "utf8");
    const loader = createLoader({ withCatalogMutation: async action => await action() });

    const first = await loader.installPlugin({ packageName: "@sps/private-npm-a", version: "1.2.0" });
    const firstMarker = await readFile(path.join(first.packagePath, "artifact-marker.txt"), "utf8");
    const second = await loader.installPlugin({ packageName: "@sps/private-npm-b", version: "2.3.0" });

    const firstRelative = path.relative(localPluginDir, first.packagePath).replace(/\\/g, "/");
    const secondRelative = path.relative(localPluginDir, second.packagePath).replace(/\\/g, "/");
    expect(firstRelative).toMatch(/^\.install-staging\/[0-9a-f-]{36}\/node_modules\/@sps\/private-npm-a$/i);
    expect(secondRelative).toMatch(/^\.install-staging\/[0-9a-f-]{36}\/node_modules\/@sps\/private-npm-b$/i);
    expect(first.packagePath).not.toBe(second.packagePath);
    expect(installed.map(item => [item.packageName, item.version])).toEqual([
      ["@sps/private-npm-a", "1.2.0"],
      ["@sps/private-npm-b", "2.3.0"],
    ]);
    expect((installedRows[0]!.input as Record<string, unknown>).packagePath).toBe(first.packagePath);
    expect((installedRows[1]!.input as Record<string, unknown>).packagePath).toBe(second.packagePath);
    const ownership = createSpsPluginArtifactOwnership(localPluginDir);
    const firstWitness = await ownership.read(firstRelative.split("/")[1]!);
    const secondWitness = await ownership.read(secondRelative.split("/")[1]!);
    expect(firstWitness.package).toEqual({ pluginKey: "sps.private-npm-a", packageName: first.packageName, version: "1.2.0" });
    expect(secondWitness.package).toEqual({ pluginKey: "sps.private-npm-b", packageName: second.packageName, version: "2.3.0" });
    expect(await readFile(path.join(first.packagePath, "artifact-marker.txt"), "utf8")).toBe(firstMarker);
    expect(await readFile(path.join(localPluginDir, "package.json"), "utf8")).toBe(rootPackageJson);
    expect(await readFile(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "utf8"))
      .toBe("root-active-copy");
  });

  it("keeps a valid link-containing package usable but does not certify it for manual cleanup", async () => {
    createNpmRunner();
    const external = path.join(root, "external-project");
    await mkdir(external);
    await writeFile(path.join(external, "keep.txt"), "caller work");
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const commandArgs = args[1] as string[];
      const callback = args[3] as (error: Error | null, stdout?: string, stderr?: string) => void;
      const prefix = commandArgs[commandArgs.indexOf("--prefix") + 1]!;
      void writeFakePackage(prefix, "@sps/linked-private", "1.0.0").then(async packageRoot => {
        await symlink(external, path.join(packageRoot, "linked-work"), process.platform === "win32" ? "junction" : "dir");
        callback(null, "", "");
      }).catch(error => callback(error));
      return {};
    });
    const installed = await createLoader().installPlugin({ packageName: "@sps/linked-private" });
    const id = path.relative(localPluginDir, installed.packagePath).split(path.sep)[1]!;
    await expect(createSpsPluginArtifactOwnership(localPluginDir).read(id)).rejects.toThrow();
    expect(await readFile(path.join(external, "keep.txt"), "utf8")).toBe("caller work");
    expect(installedRows).toHaveLength(1);
  });

  it("preserves existing linked storage compatibility without issuing cleanup ownership", async () => {
    createNpmRunner();
    const physical = path.join(root, "physical-plugins");
    await rename(localPluginDir, physical);
    await symlink(physical, localPluginDir, process.platform === "win32" ? "junction" : "dir");
    const installed = await createLoader().installPlugin({ packageName: "@sps/linked-storage" });
    expect(await readFile(path.join(installed.packagePath, "artifact-marker.txt"), "utf8")).toBe("@sps/linked-storage@1.0.0");
    expect(await readFile(path.join(physical, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "utf8")).toBe("root-active-copy");
    const id = path.relative(localPluginDir, installed.packagePath).split(path.sep)[1]!;
    await expect(createSpsPluginArtifactOwnership(localPluginDir).read(id)).rejects.toThrow("ownership");
    expect(installedRows).toHaveLength(1);
  });

  it("does not overwrite an unavailable private inventory store or make it a runtime prerequisite", async () => {
    createNpmRunner();
    const sentinel = path.join(localPluginDir, ".artifact-ownership");
    await writeFile(sentinel, "unavailable store must be preserved");
    const installed = await createLoader().installPlugin({ packageName: "@sps/unavailable-inventory" });
    expect(await readFile(path.join(installed.packagePath, "artifact-marker.txt"), "utf8")).toBe("@sps/unavailable-inventory@1.0.0");
    expect(await readFile(sentinel, "utf8")).toBe("unavailable store must be preserved");
    expect(installedRows).toHaveLength(1);
  });

  it("removes only its owned staging root after validation or transaction failure", async () => {
    createNpmRunner();
    const loader = createLoader();
    const originalPackageJson = await readFile(path.join(localPluginDir, "package.json"), "utf8");

    // The invalid manifest is materialized by the fake npm executable before
    // validation, so cleanup must remove only the fresh private prefix.
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const commandArgs = args[1] as string[];
      const callback = args[3] as (error: Error | null, stdout?: string, stderr?: string) => void;
      const prefix = commandArgs[commandArgs.indexOf("--prefix") + 1]!;
      void writeFakePackage(prefix, "@sps/invalid-private", "1.0.0", true)
        .then(() => callback(null, "", ""), (error: unknown) => callback(error as Error));
      return {};
    });
    await expect(loader.installPlugin({ packageName: "@sps/invalid-private" })).rejects.toThrow();
    expect(await readdir(path.join(localPluginDir, ".install-staging")).catch(() => [])).toEqual([]);
    expect(await readFile(path.join(localPluginDir, "package.json"), "utf8")).toBe(originalPackageJson);
    expect(await readFile(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "utf8"))
      .toBe("root-active-copy");

    createNpmRunner();
    db.transaction.mockRejectedValueOnce(new Error("transaction rejected"));
    await expect(loader.installPlugin({ packageName: "@sps/private-npm-db-failure" })).rejects.toThrow("transaction rejected");
    expect(await readdir(path.join(localPluginDir, ".install-staging")).catch(() => [])).toEqual([]);
  });

  it("retains a committed staged artifact if the catalog wrapper fails after commit", async () => {
    const installed = createNpmRunner();
    const loader = createLoader({
      withCatalogMutation: async (action) => {
        await action();
        throw new Error("catalog finalizer failed");
      },
    });

    await expect(loader.installPlugin({ packageName: "@sps/private-npm-committed" })).rejects.toThrow("catalog finalizer failed");
    expect(installed).toHaveLength(1);
    expect(await readFile(path.join(installed[0]!.packageRoot, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-committed@1.0.0");
    expect((installedRows[0]!.input as Record<string, unknown>).packagePath).toBe(installed[0]!.packageRoot);
  });

  it("preserves the registry's package when the transaction response is lost after its callback", async () => {
    const installed = createNpmRunner();
    const loader = createLoader();
    db.transaction.mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
      await callback({});
      // A driver rejection after the callback can follow a committed write.
      // The caller has no rollback evidence and must retain the exact files.
      throw new Error("transaction commit response lost");
    });

    await expect(loader.installPlugin({ packageName: "@sps/private-npm-uncertain" }))
      .rejects.toThrow("transaction commit response lost");

    expect(installed).toHaveLength(1);
    expect(installedRows).toHaveLength(1);
    const referencedPath = (installedRows[0]!.input as Record<string, unknown>).packagePath as string;
    expect(referencedPath).toBe(installed[0]!.packageRoot);
    expect(await readFile(path.join(referencedPath, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-uncertain@1.0.0");
    expect(resolvePluginPackageRoot({ packagePath: referencedPath } as never, localPluginDir)).toBe(referencedPath);
    const allocationId = path.relative(localPluginDir, referencedPath).split(path.sep)[1]!;
    const witness = await createSpsPluginArtifactOwnership(localPluginDir).read(allocationId);
    expect(witness.package.packageName).toBe("@sps/private-npm-uncertain");
  });

  it("still cleans a private install when the transaction callback rejects before COMMIT", async () => {
    const installed = createNpmRunner();
    const loader = createLoader();
    registry.install.mockRejectedValueOnce(new Error("registry write rejected inside transaction"));

    await expect(loader.installPlugin({ packageName: "@sps/private-npm-rejected" }))
      .rejects.toThrow("registry write rejected inside transaction");

    expect(installed).toHaveLength(1);
    expect(await readdir(path.join(localPluginDir, ".install-staging"))).toEqual([]);
    expect(await readFile(path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt"), "utf8"))
      .toBe("root-active-copy");
  });

  it("cleans only the exact owned staging root and skips shared npm uninstall", async () => {
    const loader = createLoader();
    const stagingRoot = path.join(localPluginDir, ".install-staging", "ad3f981a-2e83-48af-bc63-782aee7c9bb8");
    const stagedPackage = path.join(stagingRoot, "node_modules", "@sps", "private-npm-upgrade");
    await mkdir(stagedPackage, { recursive: true });
    await writeFile(path.join(stagedPackage, "marker.txt"), "staged", "utf8");
    const sharedMarker = path.join(localPluginDir, "node_modules", "@sps", "private-npm-a", "active-marker.txt");

    const stagedPlugin = { id: pluginId, packageName: "@sps/private-npm-upgrade", packagePath: stagedPackage } as never;
    await expect(loader.cleanupInstallArtifacts(stagedPlugin, undefined as never)).rejects.toThrow("maintenance window");
    await expect(withPluginPackageMutationPermit("wrong-plugin", false, permit => loader.cleanupInstallArtifacts(stagedPlugin, permit)))
      .rejects.toThrow("maintenance window");
    let expiredPermit: unknown;
    await withPluginPackageMutationPermit(pluginId, false, async permit => { expiredPermit = permit; });
    await expect(loader.cleanupInstallArtifacts(stagedPlugin, expiredPermit as never)).rejects.toThrow("maintenance window");
    const sharedLegacyPlugin = {
      id: pluginId,
      packageName: "@sps/private-npm-upgrade",
      packagePath: path.join(localPluginDir, "node_modules", "@sps", "private-npm-upgrade"),
    } as never;
    await expect(withPluginPackageMutationPermit(pluginId, false, permit => loader.cleanupInstallArtifacts(sharedLegacyPlugin, permit)))
      .rejects.toThrow("maintenance window");
    await withPluginPackageMutationPermit(pluginId, false, permit => loader.cleanupInstallArtifacts(stagedPlugin, permit));
    await expect(loader.cleanupInstallArtifacts(stagedPlugin, {} as never)).rejects.toThrow("maintenance window");

    await expect(readFile(path.join(stagedPackage, "marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sharedMarker, "utf8")).toBe("root-active-copy");
    expect(execFileMock).not.toHaveBeenCalled();
    expect(loader.requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: stagedPackage } as never)).toBe(false);
  });

  it("leaves caller-owned paths untouched and rejects malformed paths under private staging", async () => {
    const loader = createLoader();
    const callerPackage = path.join(root, "caller-checkout");
    await mkdir(callerPackage, { recursive: true });
    await writeFile(path.join(callerPackage, "marker.txt"), "caller-owned", "utf8");
    const malformedStagePath = path.join(localPluginDir, ".install-staging", "not-a-uuid", "node_modules", "@sps", "private-npm-upgrade");

    expect(loader.requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: callerPackage } as never)).toBe(false);
    const callerOwnedPlugin = { id: pluginId, packageName: "@sps/private-npm-upgrade", packagePath: callerPackage } as never;
    await withPluginPackageMutationPermit(pluginId, false, permit => loader.cleanupInstallArtifacts(callerOwnedPlugin, permit));
    const malformedPlugin = { id: pluginId, packageName: "@sps/private-npm-upgrade", packagePath: malformedStagePath } as never;
    await expect(withPluginPackageMutationPermit(pluginId, false, permit => loader.cleanupInstallArtifacts(malformedPlugin, permit)))
      .rejects.toThrow("Refusing to clean an unrecognized staged plugin artifact");
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: malformedStagePath,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    await expect(loader.prepareUpgrade(pluginId, { version: "2.0.0" }))
      .rejects.toThrow("Refusing to use an unrecognized staged plugin package path");
    expect(await readFile(path.join(callerPackage, "marker.txt"), "utf8")).toBe("caller-owned");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("fetches the requested npm version for later upgrades from a staged npm packagePath", async () => {
    const installed = createNpmRunner();
    const stagedPath = path.join(localPluginDir, ".install-staging", "ad3f981a-2e83-48af-bc63-782aee7c9bb8", "node_modules", "@sps", "private-npm-upgrade");
    await mkdir(stagedPath, { recursive: true });
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: stagedPath,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    const loader = createLoader();

    const prepared = await loader.prepareUpgrade(pluginId, { version: "2.0.0" });

    expect(installed).toHaveLength(1);
    expect(installed[0]!.packageName).toBe("@sps/private-npm-upgrade");
    expect(installed[0]!.version).toBe("2.0.0");
    expect(prepared.discovered.packagePath).not.toBe(stagedPath);
    expect(prepared.discovered.version).toBe("2.0.0");
  });

  it("fetches requested versions for legacy shared npm packagePaths too", async () => {
    const installed = createNpmRunner();
    const sharedPath = path.join(localPluginDir, "node_modules", "@sps", "private-npm-upgrade");
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: sharedPath,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    const loader = createLoader();

    const prepared = await loader.prepareUpgrade(pluginId, { version: "3.0.0" });

    expect(installed).toHaveLength(1);
    expect(installed[0]!.version).toBe("3.0.0");
    expect(prepared.discovered.packagePath).not.toBe(sharedPath);
  });

  it("keeps the direct loader upgrade path staged and commits its explicit packagePath", async () => {
    const installed = createNpmRunner();
    const stagedPath = path.join(localPluginDir, ".install-staging", "ad3f981a-2e83-48af-bc63-782aee7c9bb8", "node_modules", "@sps", "private-npm-upgrade");
    await mkdir(stagedPath, { recursive: true });
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: stagedPath,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    const loader = createLoader();

    const upgraded = await loader.upgradePlugin(pluginId, { version: "2.1.0" });

    expect(installed).toHaveLength(1);
    expect(installed[0]!.version).toBe("2.1.0");
    expect(upgraded.discovered.packagePath).toMatch(/\.upgrade-staging/);
    expect(registry.update).toHaveBeenCalledWith(pluginId, expect.objectContaining({
      packagePath: upgraded.discovered.packagePath,
      version: "2.1.0",
    }));
  });

  it("preserves an autocommitted upgrade candidate when its write response is lost", async () => {
    const installed = createNpmRunner();
    const loader = createLoader();
    let adoptedPath: string | undefined;
    registry.update.mockImplementationOnce(async (_id: string, update: { packagePath: string }) => {
      adoptedPath = update.packagePath;
      throw new Error("upgrade commit response lost");
    });

    await expect(loader.upgradePlugin(pluginId, { version: "2.2.0" }))
      .rejects.toThrow("upgrade commit response lost");

    expect(installed).toHaveLength(1);
    expect(adoptedPath).toBe(installed[0]!.packageRoot);
    expect(await readFile(path.join(adoptedPath!, "artifact-marker.txt"), "utf8"))
      .toBe("@sps/private-npm-upgrade@2.2.0");
  });

  it("removes its staged npm upgrade candidate when capability escalation is rejected", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const commandArgs = args[1] as string[];
      const callback = args[3] as (error: Error | null, stdout?: string, stderr?: string) => void;
      const prefix = commandArgs[commandArgs.indexOf("--prefix") + 1]!;
      void writeFakePackage(prefix, "@sps/private-npm-upgrade", "2.0.0", false, ["companies.read", "projects.read"])
        .then(() => callback(null, "", ""), (error: unknown) => callback(error as Error));
      return {};
    });
    registry.getById.mockResolvedValue({
      id: pluginId,
      pluginKey: activeManifest.id,
      packageName: "@sps/private-npm-upgrade",
      packagePath: null,
      version: activeManifest.version,
      status: "ready",
      manifestJson: activeManifest,
    });
    const loader = createLoader();

    await expect(loader.upgradePlugin(pluginId, { version: "2.0.0" })).rejects.toThrow("require approval");

    expect(registry.update).not.toHaveBeenCalled();
    expect(await readdir(path.join(localPluginDir, ".upgrade-staging", pluginId)).catch(() => [])).toEqual([]);
  });

  it("classifies only owned staging paths and exact legacy shared paths for cleanup", async () => {
    const privatePath = path.join(localPluginDir, ".install-staging", "ad3f981a-2e83-48af-bc63-782aee7c9bb8", "node_modules", "@sps", "private-npm-upgrade");
    const rootPath = path.join(localPluginDir, "node_modules", "@sps", "private-npm-upgrade");
    expect(requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: null }, localPluginDir)).toBe(true);
    expect(requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: rootPath }, localPluginDir)).toBe(true);
    expect(requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: privatePath }, localPluginDir)).toBe(false);
    expect(requiresSharedPluginArtifactCleanup({ packageName: "@sps/private-npm-upgrade", packagePath: path.join(root, "developer-checkout") }, localPluginDir)).toBe(false);
    expect(() => resolvePluginPackageRoot({ pluginKey: "fixture", packageName: "@sps/private-npm-upgrade", packagePath: path.join(localPluginDir, ".install-staging", "missing", "node_modules", "@sps", "private-npm-upgrade") } as never, localPluginDir))
      .toThrow("Package root not found");
  });
});
