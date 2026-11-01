import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod/v3";
import type { PluginRecord } from "../compat/paperclip/shared.js";
import type { SpsPendingPackageOperation, SpsRetainedPluginArtifactReview } from "./sps-plugin-package-operations.js";
import type { PluginWorkerArtifactReference } from "./plugin-worker-manager.js";
import type { PreparedPluginArtifactReference } from "./plugin-loader.js";
import type { RegistryStageArtifactReference } from "./registry-staging.js";
import type { SpsPluginArtifactMaintenance } from "./sps-plugin-artifact-maintenance.js";
import { captureSpsPluginArtifactReferencePath } from "./sps-plugin-artifact-reference-path.js";
import { requireSpsSourceArtifactInventory, type SpsSourceArtifactInventory } from "./sps-source-artifact-inventory.js";

const LIMIT = 60_000;
const text = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const packageName = z.string().max(256).regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/);
const absolutePath = z.string().min(1).max(32_768).refine(value => path.isAbsolute(value)
  && path.resolve(value) === value && !/[\u0000-\u001f\u007f]/.test(value));
const statuses = z.enum(["installed", "ready", "disabled", "error", "upgrade_pending", "uninstalled"]);
const pluginPathRecord = z.object({ id: text, pluginKey: text, packageName,
  packagePath: absolutePath.nullable(), version: text, status: statuses }).passthrough();
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export class SpsPluginArtifactReferencesUnavailableError extends Error {
  readonly code = "SPS_PLUGIN_ARTIFACT_REFERENCES_UNAVAILABLE";
  constructor() {
    super("Plugin artifact references are unavailable or changed; preserve their files and refresh.");
    this.name = "SpsPluginArtifactReferencesUnavailableError";
  }
}
const unavailable = () => new SpsPluginArtifactReferencesUnavailableError();

export type SpsPluginArtifactPathReference = Readonly<{
  source: "plugin" | "pending-previous" | "pending-candidate" | "pending-backup" | "review-previous" | "review-candidate" | "review-backup" | "worker" | "preparation" | "registry-stage";
  ownerId: string;
  state: string;
  path: string;
  kind: "file" | "directory";
}>;
export type SpsPluginArtifactReferenceScope = Readonly<{
  coverage: "core-only";
  references: readonly Readonly<SpsPluginArtifactPathReference & { canonicalPath: string }>[];
  /** A change key, not filesystem ownership, Host approval or a deletion permit. */
  fingerprint: string;
  sourceInventory?: SpsSourceArtifactInventory;
  assertCurrent(): Promise<void>;
}>;

export interface SpsPluginArtifactReferenceReaders {
  listPlugins(): Promise<readonly PluginRecord[]>;
  listPending(): Promise<readonly SpsPendingPackageOperation[]>;
  listRetainedReviews(): Promise<readonly SpsRetainedPluginArtifactReview[]>;
  readWorkers(): readonly PluginWorkerArtifactReference[];
  readPreparations(): readonly PreparedPluginArtifactReference[];
  readRegistryStages(): Promise<readonly RegistryStageArtifactReference[]>;
  /** Private guard only; not complete Source reconciliation or a cleanup permit. */
  readSourceFingerprint?(): Promise<string>;
  readSourceInventory?(): Promise<SpsSourceArtifactInventory>;
}

function rows<T>(value: readonly T[]): readonly T[] {
  if (!Array.isArray(value) || value.length > LIMIT) throw unavailable();
  return value;
}

async function observeReferences(root: string, readers: SpsPluginArtifactReferenceReaders) {
  const references: SpsPluginArtifactPathReference[] = [];
  const add = (source: SpsPluginArtifactPathReference["source"], ownerId: string, state: string,
    referencePath: string, kind: "file" | "directory") => {
    if (references.length >= LIMIT) throw unavailable();
    text.parse(ownerId); text.parse(state); absolutePath.parse(referencePath);
    references.push(Object.freeze({ source, ownerId, state, path: referencePath, kind }));
  };
  const addPlugin = (source: "plugin" | "pending-previous" | "pending-candidate" | "review-previous" | "review-candidate", owner: string,
    value: PluginRecord, state?: string) => {
    const record = pluginPathRecord.parse(value);
    const label = state ?? record.status;
    if (record.packagePath !== null) add(source, owner, label, record.packagePath, "directory");
    else {
      // Both retained legacy resolution locations stay protected. Do not pick
      // one based on current existence or drop a softly-uninstalled record.
      add(source, owner, label, path.join(root, "node_modules", ...record.packageName.split("/")), "directory");
      add(source, owner, label, path.join(root, ...record.packageName.split("/")), "directory");
      const worker = value.manifestJson?.entrypoints?.worker;
      if (typeof worker === "string" && path.isAbsolute(worker)) add(source, owner, label, worker, "file");
    }
    return record;
  };
  const unique = (ids: Set<string>, id: string) => {
    text.parse(id);
    if (ids.has(id)) throw unavailable();
    ids.add(id);
  };
  try {
    const pluginIds = new Set<string>();
    for (const plugin of rows(await readers.listPlugins())) {
      unique(pluginIds, plugin.id);
      addPlugin("plugin", plugin.id, plugin);
    }
    const pendingIds = new Set<string>();
    for (const operation of rows(await readers.listPending())) {
      unique(pendingIds, operation.id);
      if (operation.kind !== "uninstall" && operation.kind !== "upgrade") throw unavailable();
      if (operation.snapshot.id !== operation.pluginId || operation.snapshot.pluginKey !== operation.pluginKey) throw unavailable();
      const phase = operation.kind === "upgrade"
        ? z.enum(["prepared", "committing", "committed", "activation_entered", "rollback_required"]).parse(operation.phase)
        : "uninstall";
      addPlugin("pending-previous", operation.id, operation.snapshot, phase);
      if (operation.kind === "upgrade") {
        if (operation.candidate.id !== operation.pluginId || operation.candidate.pluginKey !== operation.pluginKey) throw unavailable();
        addPlugin("pending-candidate", operation.id, operation.candidate, phase);
        if (operation.backupFile !== null) add("pending-backup", operation.id, phase, operation.backupFile, "file");
      }
    }
    for (const review of rows(await readers.listRetainedReviews())) {
      unique(pendingIds, review.id);
      if (review.outcome !== "review_required" || review.snapshot.id !== review.pluginId || review.candidate.id !== review.pluginId
        || review.snapshot.pluginKey !== review.pluginKey || review.candidate.pluginKey !== review.pluginKey) throw unavailable();
      addPlugin("review-previous", review.id, review.snapshot, review.outcome);
      addPlugin("review-candidate", review.id, review.candidate, review.outcome);
      if (review.backupFile !== null) add("review-backup", review.id, review.outcome, review.backupFile, "file");
    }
    const workerIds = new Set<string>();
    for (const reference of rows(readers.readWorkers())) {
      unique(workerIds, reference.ownerId);
      text.parse(reference.pluginId);
      add("worker", reference.ownerId, text.parse(reference.status), reference.entrypointPath, "file");
    }
    const preparationIds = new Set<string>();
    for (const reference of rows(readers.readPreparations())) {
      unique(preparationIds, reference.ownerId);
      text.parse(reference.pluginId);
      const phase = z.enum(["preparing", "prepared", "committing", "uncertain"]).parse(reference.phase);
      add("preparation", reference.ownerId, phase, reference.artifactRoot, "directory");
    }
    const stageIds = new Set<string>();
    for (const reference of rows(await readers.readRegistryStages())) {
      unique(stageIds, reference.stageId);
      text.parse(reference.pluginId);
      const status = z.enum(["staged", "review_pending", "registered"]).parse(reference.status);
      add("registry-stage", reference.stageId, status, reference.packageRoot, "directory");
    }
    references.sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
    return Object.freeze(references);
  } catch { throw unavailable(); }
}

/** Private Core-only observation scope. Desktop process references are NOT covered. */
export function createSpsPluginArtifactReferenceReader(options: {
  localPluginDir: string;
  maintenance: SpsPluginArtifactMaintenance;
  readers: SpsPluginArtifactReferenceReaders;
}) {
  const root = absolutePath.parse(options.localPluginDir);
  const readSources = async () => {
    try {
      if (options.readers.readSourceInventory !== undefined) {
        const inventory = requireSpsSourceArtifactInventory(await options.readers.readSourceInventory());
        return { fingerprint: inventory.fingerprint, inventory };
      }
      if (options.readers.readSourceFingerprint === undefined) return { fingerprint: null, inventory: null };
      const value = await options.readers.readSourceFingerprint();
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw unavailable();
      return { fingerprint: value, inventory: null };
    } catch { throw unavailable(); }
  };
  return Object.freeze({
    async withSnapshot<T>(action: (scope: SpsPluginArtifactReferenceScope) => Promise<T>): Promise<T> {
      if (typeof action !== "function") throw new TypeError("Plugin artifact observation requires an action.");
      return options.maintenance.withMaintenance(async () => {
        let active = true;
        try {
          const references = await observeReferences(root, options.readers);
          const sources = await readSources();
          const captures = new Map<string, Awaited<ReturnType<typeof captureSpsPluginArtifactReferencePath>>>();
          const capture = async (referencePath: string, kind: "file" | "directory") => {
            const key = JSON.stringify([referencePath, kind]);
            if (!captures.has(key)) {
              try { captures.set(key, await captureSpsPluginArtifactReferencePath(referencePath, kind)); }
              catch { throw unavailable(); }
            }
            return captures.get(key)!;
          };
          await capture(root, "directory");
          const canonical = [];
          for (const reference of references) {
            const observed = await capture(reference.path, reference.kind);
            canonical.push(Object.freeze({ ...reference, canonicalPath: observed.canonicalPath }));
          }
          const signature = JSON.stringify(references);
          const fingerprint = createHash("sha256").update(JSON.stringify([root, canonical, sources.fingerprint])).digest("hex");
          const assertCurrent = async () => {
            if (!active) throw unavailable();
            if (JSON.stringify(await observeReferences(root, options.readers)) !== signature) throw unavailable();
            const currentSources = await readSources();
            if (currentSources.fingerprint !== sources.fingerprint
              || (currentSources.inventory === null) !== (sources.inventory === null)) throw unavailable();
            try { for (const observed of captures.values()) await observed.assertCurrent(); }
            catch { throw unavailable(); }
            if (!active) throw unavailable();
          };
          const scope: SpsPluginArtifactReferenceScope = Object.freeze({ coverage: "core-only",
            references: Object.freeze(canonical), fingerprint,
            ...(sources.inventory ? { sourceInventory: sources.inventory } : {}), assertCurrent });
          await assertCurrent();
          const result = await action(scope);
          await assertCurrent();
          return result;
        } finally { active = false; }
      });
    },
  });
}
