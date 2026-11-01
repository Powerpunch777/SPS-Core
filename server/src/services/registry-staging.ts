import { createHash } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { z } from "zod/v3";
import {
  assertRegistryRuntimeArtifactMatchesStatic,
  parseRegistryStaticPluginManifest,
  type RegistryStaticPluginManifest,
} from "./registry-static-manifest.js";
import type { PluginDatabaseMigrationPlan } from "./plugin-database.js";

const STAGING_INDEX_FILE = "registry-stages.json";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REFERENCE_INDEX_BYTES = 8 * 1024 * 1024;
const boundedText = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/);
const referenceVersion = boundedText(128);
const referenceCapability = boundedText(200);
const referenceCapabilities = z.array(referenceCapability).max(1000).refine(values => new Set(values).size === values.length);
const referencePluginId = z.string().regex(/^[a-z0-9][a-z0-9.-]{2,127}$/);
const referenceMigrationPlan = z.object({
  pluginId: z.string().uuid(), pluginKey: referencePluginId, targetVersion: referenceVersion,
  namespaceName: z.string().min(1).max(63).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  hasAppliedMigrations: z.boolean(), requiresHostApproval: z.boolean(), reviewHash: z.string().regex(SHA256),
  pendingMigrations: z.array(z.object({
    migrationKey: boundedText(512), checksum: z.string().regex(SHA256),
    statementCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    operationKinds: z.array(z.enum(["create", "alter", "insert", "update", "comment", "other"])).max(6)
      .refine(values => new Set(values).size === values.length),
  }).strict()).max(1000).refine(values => new Set(values.map(value => value.migrationKey)).size === values.length),
}).strict();
const referenceRecord = z.object({
  stageId: z.string().regex(/^[a-f0-9]{32}$/), pluginId: referencePluginId,
  version: referenceVersion, packageName: boundedText(256), packageRoot: boundedText(32_768),
  artifactSha256: z.string().regex(SHA256),
  staticManifest: z.object({
    schemaVersion: z.literal(1),
    plugin: z.object({ id: referencePluginId, version: referenceVersion, apiVersion: boundedText(64) }).strict(),
    runtime: z.object({ manifestEntry: boundedText(512), manifestSha256: z.string().regex(SHA256) }).strict(),
    capabilities: referenceCapabilities, permissionsDigest: z.string().regex(SHA256),
  }).strict(),
  source: z.object({ registryId: boundedText(128), kind: z.enum(["local", "git", "official"]), releaseLocator: boundedText(2048) }).strict(),
  status: z.enum(["staged", "review_pending", "registered"]),
  review: z.object({
    pluginRecordId: z.string().uuid(), targetVersion: referenceVersion, addedCapabilities: referenceCapabilities,
    migrationPlan: referenceMigrationPlan.nullable(), requestedAt: z.string().datetime(),
  }).strict().nullable(),
  stagedAt: z.string().datetime(),
}).strict();
const referenceIndex = z.array(referenceRecord).max(10_000);

/** Host-private protection reference only; neither filesystem ownership nor deletion authority. */
export interface RegistryStageArtifactReference {
  readonly stageId: string;
  readonly pluginId: string;
  readonly status: RegistryStagedPluginRecord["status"];
  readonly packageRoot: string;
}

export interface RegistryStagedPluginRecord {
  stageId: string;
  pluginId: string;
  version: string;
  packageName: string;
  packageRoot: string;
  artifactSha256: string;
  staticManifest: RegistryStaticPluginManifest;
  source: {
    registryId: string;
    kind: "local" | "git" | "official";
    releaseLocator: string;
  };
  /**
   * Staged is static-only. A review_pending stage is pinned to one installed
   * plugin until the Host approves that exact candidate. Registered means the
   * candidate has completed its lifecycle activation.
   */
  status: "staged" | "review_pending" | "registered";
  review: RegistryStageReview | null;
  stagedAt: string;
}

export interface RegistryStageReview {
  pluginRecordId: string;
  targetVersion: string;
  addedCapabilities: string[];
  migrationPlan: PluginDatabaseMigrationPlan | null;
  requestedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function stageIdFor(pluginId: string, version: string, artifactSha256: string): string {
  return createHash("sha256").update(`${pluginId}\n${version}\n${artifactSha256}`, "utf8").digest("hex").slice(0, 32);
}

const referencesUnavailable = () => new Error("Registry stage artifact references are unavailable; preserve staged packages.");
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
const sameMetadata = (left: BigIntStats, right: BigIntStats) => sameIdentity(left, right)
  && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

async function referenceLstat(absolute: string): Promise<BigIntStats | null> {
  try { return await fs.lstat(absolute, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function captureReferenceAncestry(absolute: string) {
  const directories: Array<{ absolute: string; stats: BigIntStats | null }> = [];
  for (let current = absolute;; current = path.dirname(current)) {
    const stats = await referenceLstat(current);
    if (stats && (!stats.isDirectory() || stats.isSymbolicLink())) throw referencesUnavailable();
    directories.push({ absolute: current, stats });
    if (path.dirname(current) === current) break;
  }
  return directories;
}

async function captureReferenceDirectories(absolute: string) {
  const directories = await captureReferenceAncestry(absolute);
  const existing = directories.find(directory => directory.stats);
  if (!existing?.stats) throw referencesUnavailable();
  const canonicalExisting = await fs.realpath(existing.absolute);
  const canonicalDirectories = await captureReferenceAncestry(canonicalExisting);
  const resolved = canonicalDirectories[0]!.stats;
  if (!resolved || !sameIdentity(existing.stats, resolved)) throw referencesUnavailable();
  // Preserve missing descendants while resolving only an existing, link-free
  // parent. Windows case/8.3 aliases must identify the same captured directory.
  const canonicalRoot = path.resolve(canonicalExisting, path.relative(existing.absolute, absolute));
  return { directories, existing, canonicalExisting, canonicalDirectories, canonicalRoot };
}

async function recheckReferenceAncestry(directories: Awaited<ReturnType<typeof captureReferenceAncestry>>, membership: boolean) {
  for (const [index, original] of directories.entries()) {
    const current = await referenceLstat(original.absolute);
    if (!original.stats) {
      if (current) throw referencesUnavailable();
    } else if (!current || !current.isDirectory() || current.isSymbolicLink()
      || !(membership && index === 0 ? sameMetadata(original.stats, current) : sameIdentity(original.stats, current))) {
      throw referencesUnavailable();
    }
  }
}

async function recheckReferenceDirectories(captured: Awaited<ReturnType<typeof captureReferenceDirectories>>, membership = false) {
  await recheckReferenceAncestry(captured.directories, membership);
  await recheckReferenceAncestry(captured.canonicalDirectories, membership && captured.directories[0]!.stats !== null);
  if (await fs.realpath(captured.existing.absolute) !== captured.canonicalExisting) throw referencesUnavailable();
}

async function readReferenceIndex(indexPath: string, before: BigIntStats): Promise<unknown> {
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size > BigInt(MAX_REFERENCE_INDEX_BYTES)) throw referencesUnavailable();
  const handle = await fs.open(indexPath, constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameMetadata(before, opened)) throw referencesUnavailable();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > Number(before.size)) throw referencesUnavailable();
    }
    if (length !== Number(before.size) || !sameMetadata(before, await handle.stat({ bigint: true }))) throw referencesUnavailable();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    const normalized = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n/g, "\n");
    const value: unknown = JSON.parse(normalized);
    // Only the current pretty-JSON writer spelling is readable here, with an
    // optional final newline/BOM/CRLF. Duplicate (also escaped) keys cannot round-trip.
    const writerText = JSON.stringify(value, null, 2);
    if (normalized !== writerText && normalized !== `${writerText}\n`) throw referencesUnavailable();
    return value;
  } finally { await handle.close(); }
}

async function readRegistryArtifactReferences(root: string, indexPath: string): Promise<readonly RegistryStageArtifactReference[]> {
  try {
    if (root.length > 32_768 || /[\u0000-\u001f\u007f]/.test(root)) throw referencesUnavailable();
    const directories = await captureReferenceDirectories(root);
    const referenceStorageRoot = directories.canonicalRoot;
    const before = await referenceLstat(indexPath);
    if (!before) {
      await recheckReferenceDirectories(directories, true);
      if (await referenceLstat(indexPath)) throw referencesUnavailable();
      return Object.freeze([]);
    }
    const records = referenceIndex.parse(await readReferenceIndex(indexPath, before));
    const ids = new Set<string>();
    for (const record of records) {
      parseRegistryStaticPluginManifest(record.staticManifest);
      if (ids.has(record.stageId) || record.stageId !== stageIdFor(record.pluginId, record.version, record.artifactSha256)
        || record.pluginId !== record.staticManifest.plugin.id || record.version !== record.staticManifest.plugin.version
        || !path.isAbsolute(record.packageRoot) || path.resolve(record.packageRoot) !== record.packageRoot
        || path.relative(path.parse(record.packageRoot).root, record.packageRoot).split(path.sep)
          .some(part => /[:\u0000-\u001f\u007f]|[. ]$/.test(part))
        || (record.status === "review_pending") !== (record.review !== null)) throw referencesUnavailable();
      ids.add(record.stageId);
      if (record.review) {
        const review = record.review;
        const plan = review.migrationPlan;
        if (review.targetVersion !== record.version
          || review.addedCapabilities.some(capability => !record.staticManifest.capabilities.includes(capability))
          || plan && (plan.pluginId !== review.pluginRecordId || plan.pluginKey !== record.pluginId || plan.targetVersion !== record.version)) {
          throw referencesUnavailable();
        }
      }
    }
    // Missing package directories remain references. Existing links are not adopted.
    const packageDirectories = [];
    for (const record of records) {
      const captured = await captureReferenceDirectories(record.packageRoot);
      if (!isPathInside(referenceStorageRoot, captured.canonicalRoot)) throw referencesUnavailable();
      packageDirectories.push(captured);
    }
    for (const captured of packageDirectories) await recheckReferenceDirectories(captured);
    await recheckReferenceDirectories(directories, true);
    const after = await referenceLstat(indexPath);
    if (!after || !after.isFile() || after.isSymbolicLink() || !sameMetadata(before, after)) throw referencesUnavailable();
    return Object.freeze(records.map(({ stageId, pluginId, status, packageRoot }) =>
      Object.freeze({ stageId, pluginId, status, packageRoot })));
  } catch { throw referencesUnavailable(); }
}

function validateStageSource(source: RegistryStagedPluginRecord["source"]): void {
  if (!isPlainObject(source)) throw new Error("Registry stage source must be an object.");
  if (typeof source.registryId !== "string" || source.registryId.length === 0 || source.registryId.length > 128) {
    throw new Error("Registry stage source registryId is required.");
  }
  if (!new Set(["local", "git", "official"]).has(source.kind)) throw new Error("Registry stage source kind is invalid.");
  if (typeof source.releaseLocator !== "string" || source.releaseLocator.length === 0 || source.releaseLocator.length > 2048) {
    throw new Error("Registry stage source releaseLocator is required.");
  }
}

async function readIndex(indexPath: string): Promise<RegistryStagedPluginRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Registry stage index must be an array.");
    return parsed as RegistryStagedPluginRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeIndex(indexPath: string, records: RegistryStagedPluginRecord[]): Promise<void> {
  const temporaryPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, indexPath);
}

/**
 * Keeps Registry packages outside the executable Plugin database lifecycle.
 * Packages enter this store only after a safe extractor produced their folder;
 * no dynamic manifest, migration, worker, or plugin code is loaded here.
 */
export function registryStagingService(stagingRoot: string) {
  const root = path.resolve(stagingRoot);
  const indexPath = path.join(root, STAGING_INDEX_FILE);

  async function resolveManagedPackageRoot(packageRoot: string): Promise<string> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const realRoot = await fs.realpath(root);
    const realPackageRoot = await fs.realpath(packageRoot);
    if (!isPathInside(realRoot, realPackageRoot)) {
      throw new Error("Registry staged package must stay inside the managed staging root.");
    }
    const packageStats = await fs.lstat(realPackageRoot);
    if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
      throw new Error("Registry staged package must be a regular directory.");
    }
    return realPackageRoot;
  }

  return {
    /** Strict Host-private snapshot; unavailable is never an empty reference set. */
    readArtifactReferences: async (): Promise<readonly RegistryStageArtifactReference[]> => readRegistryArtifactReferences(root, indexPath),

    list: async (): Promise<RegistryStagedPluginRecord[]> => await readIndex(indexPath),

    get: async (stageId: string): Promise<RegistryStagedPluginRecord | null> => {
      const records = await readIndex(indexPath);
      return records.find((record) => record.stageId === stageId) ?? null;
    },

    findPendingReview: async (pluginRecordId: string): Promise<RegistryStagedPluginRecord | null> => {
      const records = await readIndex(indexPath);
      return records.find(
        (record) => record.status === "review_pending" && record.review?.pluginRecordId === pluginRecordId,
      ) ?? null;
    },

    stage: async (input: {
      packageRoot: string;
      artifactSha256: string;
      source: RegistryStagedPluginRecord["source"];
    }): Promise<RegistryStagedPluginRecord> => {
      if (!SHA256.test(input.artifactSha256)) throw new Error("Registry staged package requires lowercase artifact SHA-256.");
      validateStageSource(input.source);
      const managedPackageRoot = await resolveManagedPackageRoot(input.packageRoot);
      const staticManifestPath = path.join(managedPackageRoot, "sps-plugin.json");
      const packageJsonPath = path.join(managedPackageRoot, "package.json");
      const [staticStats, packageStats] = await Promise.all([fs.lstat(staticManifestPath), fs.lstat(packageJsonPath)]);
      if (!staticStats.isFile() || staticStats.isSymbolicLink()) throw new Error("Registry staged package sps-plugin.json must be a regular file.");
      if (!packageStats.isFile() || packageStats.isSymbolicLink()) throw new Error("Registry staged package package.json must be a regular file.");

      const staticManifest = parseRegistryStaticPluginManifest(JSON.parse(await fs.readFile(staticManifestPath, "utf8")));
      const packageJson: unknown = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      if (!isPlainObject(packageJson) || typeof packageJson.name !== "string" || packageJson.name.length === 0) {
        throw new Error("Registry staged package package.json name is required.");
      }
      if (packageJson.version !== staticManifest.plugin.version) {
        throw new Error("Registry staged package version does not match sps-plugin.json.");
      }
      await assertRegistryRuntimeArtifactMatchesStatic({
        packageRoot: managedPackageRoot,
        manifestPath: path.join(managedPackageRoot, staticManifest.runtime.manifestEntry),
        staticManifest,
      });

      const stageId = stageIdFor(staticManifest.plugin.id, staticManifest.plugin.version, input.artifactSha256);
      const record: RegistryStagedPluginRecord = {
        stageId,
        pluginId: staticManifest.plugin.id,
        version: staticManifest.plugin.version,
        packageName: packageJson.name,
        packageRoot: managedPackageRoot,
        artifactSha256: input.artifactSha256,
        staticManifest,
        source: input.source,
        status: "staged",
        review: null,
        stagedAt: new Date().toISOString(),
      };
      const records = await readIndex(indexPath);
      const existingIndex = records.findIndex((candidate) => candidate.stageId === stageId);
      if (existingIndex >= 0) records[existingIndex] = record;
      else records.push(record);
      await writeIndex(indexPath, records);
      return record;
    },

    remove: async (stageId: string): Promise<boolean> => {
      const records = await readIndex(indexPath);
      const next = records.filter((record) => record.stageId !== stageId);
      if (next.length === records.length) return false;
      await writeIndex(indexPath, next);
      return true;
    },

    markReviewPending: async (
      stageId: string,
      review: Omit<RegistryStageReview, "requestedAt">,
    ): Promise<RegistryStagedPluginRecord | null> => {
      const records = await readIndex(indexPath);
      const index = records.findIndex((record) => record.stageId === stageId);
      if (index < 0) return null;
      const existing = records[index]!;
      const updated: RegistryStagedPluginRecord = {
        ...existing,
        status: "review_pending",
        review: {
          ...review,
          requestedAt: new Date().toISOString(),
        },
      };
      records[index] = updated;
      await writeIndex(indexPath, records);
      return updated;
    },

    markRegistered: async (stageId: string): Promise<RegistryStagedPluginRecord | null> => {
      const records = await readIndex(indexPath);
      const index = records.findIndex((record) => record.stageId === stageId);
      if (index < 0) return null;
      const existing = records[index]!;
      const updated: RegistryStagedPluginRecord = {
        ...existing,
        status: "registered",
        review: null,
      };
      records[index] = updated;
      await writeIndex(indexPath, records);
      return updated;
    },
  };
}
