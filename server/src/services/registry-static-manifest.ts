import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const REGISTRY_STATIC_PLUGIN_MANIFEST_VERSION = 1;

const PLUGIN_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RegistryStaticPluginManifest {
  schemaVersion: 1;
  plugin: {
    id: string;
    version: string;
    apiVersion: string;
  };
  runtime: {
    manifestEntry: string;
    manifestSha256: string;
  };
  capabilities: string[];
  permissionsDigest: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isSafeRelativeFilePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !value.includes("\\")
    && !value.includes("\u0000")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function calculateRegistryCapabilitiesDigest(capabilities: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...capabilities].sort()), "utf8")
    .digest("hex");
}

/** Parses the declarative file allowed during Registry disabled installation. */
export function parseRegistryStaticPluginManifest(value: unknown): RegistryStaticPluginManifest {
  if (!isPlainObject(value)) throw new Error("sps-plugin.json must contain an object.");
  if (value.schemaVersion !== REGISTRY_STATIC_PLUGIN_MANIFEST_VERSION) {
    throw new Error("Unsupported sps-plugin.json schemaVersion.");
  }
  if (!isPlainObject(value.plugin)) throw new Error("sps-plugin.json plugin must be an object.");
  if (!PLUGIN_ID.test(String(value.plugin.id ?? ""))) throw new Error("sps-plugin.json plugin.id is invalid.");
  if (!SEMVER.test(String(value.plugin.version ?? ""))) throw new Error("sps-plugin.json plugin.version must be SemVer.");
  if (typeof value.plugin.apiVersion !== "string" || value.plugin.apiVersion.trim().length === 0 || value.plugin.apiVersion.length > 64) {
    throw new Error("sps-plugin.json plugin.apiVersion is required.");
  }

  if (!isPlainObject(value.runtime)) throw new Error("sps-plugin.json runtime must be an object.");
  if (!isSafeRelativeFilePath(value.runtime.manifestEntry) || !/\.(?:c|m)?js$/i.test(value.runtime.manifestEntry)) {
    throw new Error("sps-plugin.json runtime.manifestEntry must be a safe JavaScript file path.");
  }
  if (!SHA256.test(String(value.runtime.manifestSha256 ?? ""))) {
    throw new Error("sps-plugin.json runtime.manifestSha256 must be lowercase SHA-256 hex.");
  }

  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) {
    throw new Error("sps-plugin.json capabilities must contain bounded strings.");
  }
  const capabilities = value.capabilities as string[];
  if (new Set(capabilities).size !== capabilities.length) throw new Error("sps-plugin.json capabilities must not contain duplicates.");
  if (!SHA256.test(String(value.permissionsDigest ?? ""))) {
    throw new Error("sps-plugin.json permissionsDigest must be lowercase SHA-256 hex.");
  }
  if (calculateRegistryCapabilitiesDigest(capabilities) !== value.permissionsDigest) {
    throw new Error("sps-plugin.json permissionsDigest does not match capabilities.");
  }

  return value as unknown as RegistryStaticPluginManifest;
}

/**
 * Verifies the reviewed runtime source without evaluating it. This must run
 * before a Registry package's JavaScript manifest is imported.
 */
export async function assertRegistryRuntimeArtifactMatchesStatic(input: {
  packageRoot: string;
  manifestPath: string;
  staticManifest: RegistryStaticPluginManifest;
}): Promise<void> {
  const reviewed = parseRegistryStaticPluginManifest(input.staticManifest);
  const packageRoot = await realpath(input.packageRoot);
  const expectedManifestPath = path.resolve(packageRoot, reviewed.runtime.manifestEntry);
  const requestedManifestPath = path.resolve(input.manifestPath);
  if (requestedManifestPath !== expectedManifestPath) {
    throw new Error("Runtime manifest path does not match sps-plugin.json.");
  }

  const [packageStats, manifestStats, realManifestPath] = await Promise.all([
    lstat(packageRoot),
    lstat(expectedManifestPath),
    realpath(expectedManifestPath),
  ]);
  if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
    throw new Error("Registry package root must be a regular directory.");
  }
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || !isPathInside(packageRoot, realManifestPath)) {
    throw new Error("Registry runtime manifest must be a regular file inside the package root.");
  }

  const manifestSource = await readFile(realManifestPath);
  const manifestHash = createHash("sha256").update(manifestSource).digest("hex");
  if (manifestHash !== reviewed.runtime.manifestSha256) {
    throw new Error("Runtime manifest SHA-256 does not match sps-plugin.json.");
  }
}

/**
 * Runs only after the Owner explicitly enables a staged Registry plugin. The
 * JavaScript import is intentionally outside disabled install; once loaded,
 * it must still match the previously reviewed static declaration exactly.
 */
export async function assertRegistryRuntimeManifestMatchesStatic(input: {
  packageRoot: string;
  manifestPath: string;
  staticManifest: RegistryStaticPluginManifest;
  runtimeManifest: PaperclipPluginManifestV1;
}): Promise<void> {
  const reviewed = parseRegistryStaticPluginManifest(input.staticManifest);
  await assertRegistryRuntimeArtifactMatchesStatic(input);

  const runtimeCapabilities = [...input.runtimeManifest.capabilities].sort();
  const reviewedCapabilities = [...reviewed.capabilities].sort();
  if (
    input.runtimeManifest.id !== reviewed.plugin.id
    || input.runtimeManifest.version !== reviewed.plugin.version
    || String(input.runtimeManifest.apiVersion) !== reviewed.plugin.apiVersion
    || runtimeCapabilities.length !== reviewedCapabilities.length
    || runtimeCapabilities.some((capability, index) => capability !== reviewedCapabilities[index])
  ) {
    throw new Error("Runtime manifest identity or capabilities do not match sps-plugin.json.");
  }
}
