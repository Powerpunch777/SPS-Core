import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertRegistryRuntimeArtifactMatchesStatic,
  parseRegistryStaticPluginManifest,
  type RegistryStaticPluginManifest,
} from "./registry-static-manifest.js";
import type { PluginDatabaseMigrationPlan } from "./plugin-database.js";

const STAGING_INDEX_FILE = "registry-stages.json";
const SHA256 = /^[a-f0-9]{64}$/;

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
