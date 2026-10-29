/**
 * PluginLifecycleManager — state-machine controller for plugin status
 * transitions and worker process coordination.
 *
 * Each plugin moves through a well-defined state machine:
 *
 * ```
 *   installed ──→ ready ──→ disabled
 *       │            │         │
 *       │            ├──→ error│
 *       │            ↓         │
 *       │     upgrade_pending  │
 *       │            │         │
 *       ↓            ↓         ↓
 *              uninstalled
 * ```
 *
 * The lifecycle manager:
 *
 * 1. **Validates transitions** — Only transitions defined in
 *    `VALID_TRANSITIONS` are allowed; invalid transitions throw.
 *
 * 2. **Coordinates workers** — When a plugin moves to `ready`, its
 *    worker process is started. When it moves out of `ready`, the
 *    worker is stopped gracefully.
 *
 * 3. **Emits events** — `plugin.loaded`, `plugin.enabled`,
 *    `plugin.disabled`, `plugin.unloaded`, `plugin.status_changed`
 *    events are emitted so that other services (job coordinator,
 *    tool dispatcher, event bus) can react accordingly.
 *
 * 4. **Persists state** — Status changes are written to the database
 *    through the plugin registry service.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 */
import { EventEmitter } from "node:events";
import type { Db } from "@paperclipai/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import {
  pluginLoader,
  type PluginLoader,
  type PluginUpgradeOptions,
} from "./plugin-loader.js";
import { pluginDatabaseService } from "./plugin-database.js";
import type { PluginWorkerManager, WorkerStartOptions } from "./plugin-worker-manager.js";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { withSpsPluginRuntimeMutation, type SpsPluginRuntimeMutationCoordinator } from "./sps-plugin-runtime-mutation.js";
import {
  PluginPackageMaintenanceRequiredError,
  type PluginPackageMutationPermit,
} from "./sps-plugin-package-maintenance.js";
import { samePluginPackageArtifact, type SpsPluginPackageOperation, type SpsPluginPackageOperations } from "./sps-plugin-package-operations.js";

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the plugin lifecycle.
 *
 *   installed → ready       (initial load succeeds)
 *   installed → error       (initial load fails)
 *   installed → uninstalled (abort installation)
 *
 *   ready → disabled        (operator disables plugin)
 *   ready → error           (runtime failure)
 *   ready → upgrade_pending (upgrade with new capabilities)
 *   ready → uninstalled     (uninstall)
 *
 *   disabled → ready        (operator re-enables plugin)
 *   disabled → uninstalled  (uninstall while disabled)
 *
 *   error → ready           (retry / recovery)
 *   error → uninstalled     (give up and uninstall)
 *
 *   upgrade_pending → ready       (operator approves new capabilities)
 *   upgrade_pending → error       (upgrade worker fails)
 *   upgrade_pending → uninstalled (reject upgrade and uninstall)
 *
 *   uninstalled → installed (reinstall)
 */
const VALID_TRANSITIONS: Record<string, readonly PluginStatus[]> = {
  installed: ["ready", "error", "uninstalled"],
  ready: ["ready", "disabled", "error", "upgrade_pending", "uninstalled"],
  disabled: ["ready", "upgrade_pending", "uninstalled"],
  error: ["ready", "upgrade_pending", "uninstalled"],
  upgrade_pending: ["ready", "error", "uninstalled"],
  uninstalled: ["installed"], // reinstall
};

/**
 * Check whether a transition from `from` → `to` is valid.
 */
function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the PluginLifecycleManager.
 * Consumers can subscribe to these for routing-table updates, UI refresh
 * notifications, and observability.
 */
export interface PluginLifecycleEvents {
  /** Emitted after a plugin is loaded (installed → ready). */
  "plugin.loaded": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin transitions to ready (enabled). */
  "plugin.enabled": { pluginId: string; pluginKey: string };
  /** Emitted after a plugin is disabled (ready → disabled). */
  "plugin.disabled": { pluginId: string; pluginKey: string; reason?: string };
  /** Emitted after a plugin is unloaded (any → uninstalled). */
  "plugin.unloaded": { pluginId: string; pluginKey: string; removeData: boolean };
  /** Emitted on any status change. */
  "plugin.status_changed": {
    pluginId: string;
    pluginKey: string;
    previousStatus: PluginStatus;
    newStatus: PluginStatus;
  };
  /** Emitted when a plugin enters an error state. */
  "plugin.error": { pluginId: string; pluginKey: string; error: string };
  /** Emitted when a plugin enters upgrade_pending. */
  "plugin.upgrade_pending": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been started. */
  "plugin.worker_started": { pluginId: string; pluginKey: string };
  /** Emitted when a plugin worker process has been stopped. */
  "plugin.worker_stopped": { pluginId: string; pluginKey: string };
}

/**
 * Lifecycle-owned upgrade options. Passing a local path is useful for an
 * already verified Registry stage, while the lifecycle remains responsible
 * for stopping and starting the plugin runtime around the replacement.
 */
export type PluginLifecycleUpgradeOptions = PluginUpgradeOptions;

type LifecycleEventName = keyof PluginLifecycleEvents;
type LifecycleEventPayload<K extends LifecycleEventName> = PluginLifecycleEvents[K];

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

export interface PluginLifecycleManager {
  /** Resume durable removal intents before normal startup admission. */
  recoverPackageOperations?(): Promise<void>;
  /**
   * Attach the runtime-capable loader after the lifecycle and loader finish
   * their circular server composition. This may be called only once unless the
   * same loader instance is supplied again.
   */
  attachRuntimeLoader(loader: PluginLoader): void;

  /**
   * Load a newly installed plugin – transitions `installed` → `ready`.
   *
   * This is called after the registry has persisted the initial install record.
   * The caller should have already spawned the worker and performed health
   * checks before calling this.  If the worker fails, call `markError` instead.
   */
  load(pluginId: string): Promise<PluginRecord>;

  /**
   * Enable a plugin that is in `disabled`, `error`, or `upgrade_pending` state.
   * Transitions → `ready`.
   */
  enable(pluginId: string): Promise<PluginRecord>;

  /**
   * Disable a running plugin.
   * Transitions `ready` → `disabled`.
   */
  disable(pluginId: string, reason?: string): Promise<PluginRecord>;

  /**
   * Unload (uninstall) a plugin from any active state.
   * Transitions → `uninstalled`.
   *
   * When `removeData` is true, the plugin row and cascaded config are
   * hard-deleted.  Otherwise a soft-delete sets status to `uninstalled`.
   */
  unload(pluginId: string, removeData?: boolean): Promise<PluginRecord | null>;

  /**
   * Mark a plugin as errored (e.g. worker crash, health-check failure).
   * Transitions → `error`.
   */
  markError(pluginId: string, error: string): Promise<PluginRecord>;

  /**
   * Mark a plugin as requiring upgrade approval.
   * Transitions `ready` → `upgrade_pending`.
   */
  markUpgradePending(pluginId: string): Promise<PluginRecord>;

  /**
   * Upgrade a plugin to a newer version.
   * This is a placeholder that handles the lifecycle state transition.
   * The actual package installation is handled by plugin-loader.
   *
   * If the upgrade adds new capabilities, transitions to `upgrade_pending`.
   * Otherwise, transitions to `ready` directly.
   */
  upgrade(pluginId: string, options?: string | PluginLifecycleUpgradeOptions): Promise<PluginRecord>;

  /**
   * Start the worker process for a plugin that is already in `ready` state.
   *
   * This is used by the server startup orchestration to start workers for
   * plugins that were persisted as `ready`. It requires a `PluginWorkerManager`
   * to have been provided at construction time.
   *
   * @param pluginId - The UUID of the plugin to start
   * @param options  - Worker start options (entrypoint path, config, etc.)
   * @throws if no worker manager is configured or the plugin is not ready
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<void>;

  /**
   * Stop the worker process for a plugin without changing lifecycle state.
   *
   * This is used during server shutdown to gracefully stop all workers.
   * It does not transition the plugin state — plugins remain in their
   * current status so they can be restarted on next server boot.
   *
   * @param pluginId - The UUID of the plugin to stop
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Restart the worker process for a running plugin.
   *
   * Stops and re-starts the worker process. The plugin remains in `ready`
   * state throughout. This is typically called after a config change.
   *
   * @param pluginId - The UUID of the plugin to restart
   * @throws if no worker manager is configured or the plugin is not ready
   */
  restartWorker(pluginId: string): Promise<void>;

  /**
   * Get the current lifecycle state for a plugin.
   */
  getStatus(pluginId: string): Promise<PluginStatus | null>;

  /**
   * Check whether a transition is allowed from the plugin's current state.
   */
  canTransition(pluginId: string, to: PluginStatus): Promise<boolean>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Subscribe to a lifecycle event once.
   */
  once<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
export interface PluginLifecycleManagerOptions {
  /** Core composition supplies the durable Host package-operation store. */
  packageOperations?: SpsPluginPackageOperations;
  /** Optional Core-owned Workspace process drain and policy reconciliation. */
  workspaceRuntime?: SpsPluginRuntimeMutationCoordinator;
  /** Plugin loader instance. Falls back to the default if omitted. */
  loader?: PluginLoader;

  /**
   * Worker process manager. When provided, lifecycle transitions that bring
   * a plugin online (load, enable, upgrade-to-ready) will start the worker
   * process, and transitions that take a plugin offline (disable, unload,
   * markError) will stop it.
   *
   * When omitted and the loader has no runtime services, the lifecycle manager
   * operates in state-only mode. Runtime-backed stop/replacement transitions
   * require this owner so they can verify closure and fence concurrent starts.
   */
  workerManager?: PluginWorkerManager;

  /** Database connection used for restricted plugin namespace migrations. */
  migrationDb?: Db;

  /** Host-owned backup service used before an approved data migration runs. */
  databaseBackupService?: {
    runManualBackup(): Promise<{ backupFile?: string; startedAt?: string; finishedAt?: string }>;
  };
}

/**
 * Create a PluginLifecycleManager.
 *
 * This service orchestrates plugin state transitions on top of the
 * `pluginRegistryService` (which handles raw DB persistence).  It enforces
 * the lifecycle state machine, emits events for downstream consumers
 * (routing tables, UI, observability), and manages worker processes via
 * the `PluginWorkerManager` when one is provided.
 *
 * Usage:
 * ```ts
 * const lifecycle = pluginLifecycleManager(db, {
 *   workerManager: createPluginWorkerManager(),
 * });
 * lifecycle.on("plugin.enabled", ({ pluginId }) => { ... });
 * await lifecycle.load(pluginId);
 * ```
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugins.status` column
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLifecycleManager(
  db: Db,
  options?: PluginLoader | PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  // Support the legacy signature: pluginLifecycleManager(db, loader)
  // as well as the new options object form.
  let loaderArg: PluginLoader | undefined;
  let workerManager: PluginWorkerManager | undefined;
  let migrationDb = db;
  let databaseBackupService: PluginLifecycleManagerOptions["databaseBackupService"];
  let workspaceRuntime: SpsPluginRuntimeMutationCoordinator | undefined;
  let packageOperations: SpsPluginPackageOperations | undefined;

  if (options && typeof options === "object" && "discoverAll" in options) {
    // Legacy: second arg is a PluginLoader directly
    loaderArg = options as PluginLoader;
  } else if (options && typeof options === "object") {
    const opts = options as PluginLifecycleManagerOptions;
    loaderArg = opts.loader;
    workerManager = opts.workerManager;
    migrationDb = opts.migrationDb ?? db;
    databaseBackupService = opts.databaseBackupService;
    workspaceRuntime = opts.workspaceRuntime;
    packageOperations = opts.packageOperations;
  }

  const registry = pluginRegistryService(db);
  let pluginLoaderInstance = loaderArg ?? pluginLoader(db);
  let runtimeLoaderAttached = Boolean(loaderArg);
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100); // plugins may have many listeners; 100 is a safe upper bound

  const log = logger.child({ service: "plugin-lifecycle" });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin as PluginRecord;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw badRequest(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin?: PluginRecord,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? await requirePlugin(pluginId);
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated) throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated as PluginRecord;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    // Emit the generic status_changed event
    emitter.emit("plugin.status_changed", {
      pluginId,
      pluginKey: result.pluginKey,
      previousStatus,
      newStatus: to,
    });

    return result;
  }

  function emitDomain(
    event: LifecycleEventName,
    payload: PluginLifecycleEvents[LifecycleEventName],
  ): void {
    emitter.emit(event, payload);
  }

  // -----------------------------------------------------------------------
  // Worker management helpers
  // -----------------------------------------------------------------------

  /**
   * Stop the worker for a plugin if one is running. A registered handle must
   * be removed by the manager before this reports success.
   */
  async function stopWorkerIfRunning(
    pluginId: string,
    pluginKey: string,
  ): Promise<void> {
    if (!workerManager) return;
    if (!workerManager.isRunning(pluginId) && !workerManager.getWorker(pluginId)) return;

    await workerManager.stopWorker(pluginId);
    if (workerManager.getWorker(pluginId)) {
      throw new PluginPackageMaintenanceRequiredError();
    }
    log.info({ pluginId, pluginKey }, "plugin lifecycle: worker stopped");
    emitDomain("plugin.worker_stopped", { pluginId, pluginKey });
  }

  async function activateReadyPlugin(
    pluginId: string,
    approvedMigrationPlanHash?: string,
  ): Promise<void> {
    const supportsRuntimeActivation =
      typeof pluginLoaderInstance.hasRuntimeServices === "function"
      && typeof pluginLoaderInstance.loadSingle === "function";
    if (!supportsRuntimeActivation || !pluginLoaderInstance.hasRuntimeServices()) {
      return;
    }

    const loadResult = approvedMigrationPlanHash
      ? await pluginLoaderInstance.loadSingle(pluginId, { approvedMigrationPlanHash })
      : await pluginLoaderInstance.loadSingle(pluginId);
    if (!loadResult.success) {
      throw new Error(
        loadResult.error
        ?? `Failed to activate plugin ${loadResult.plugin.pluginKey}`,
      );
    }
  }

  async function deactivatePluginRuntime(
    pluginId: string,
    pluginKey: string,
  ): Promise<void> {
    const supportsRuntimeDeactivation =
      typeof pluginLoaderInstance.hasRuntimeServices === "function"
      && typeof pluginLoaderInstance.unloadSingle === "function";

    if (supportsRuntimeDeactivation && pluginLoaderInstance.hasRuntimeServices()) {
      await pluginLoaderInstance.unloadSingle(pluginId, pluginKey);
      return;
    }

    await stopWorkerIfRunning(pluginId, pluginKey);
  }

  async function withArtifactCleanupFence<T>(
    plugin: PluginRecord,
    action: (permit: PluginPackageMutationPermit) => Promise<T>,
  ): Promise<T> {
    const classify = pluginLoaderInstance.requiresSharedPluginArtifactCleanup;
    if (typeof classify !== "function" || !workerManager) {
      throw new PluginPackageMaintenanceRequiredError();
    }
    if (classify.call(pluginLoaderInstance, plugin)) {
      if (typeof workerManager.withExclusivePackageMutation !== "function") throw new PluginPackageMaintenanceRequiredError();
      return workerManager.withExclusivePackageMutation(plugin.id, action);
    }
    if (typeof workerManager.withPluginPackageMutation !== "function") throw new PluginPackageMaintenanceRequiredError();
    return workerManager.withPluginPackageMutation(plugin.id, action);
  }

  async function finishDurableUninstall(operation: SpsPluginPackageOperation): Promise<PluginRecord | null> {
    const snapshot = operation.snapshot;
    return withArtifactCleanupFence(snapshot, async permit => {
      const current = await registry.getById(snapshot.id) as PluginRecord | null;
      const sameKey = current ? current : await registry.getByKey(snapshot.pluginKey) as PluginRecord | null;
      if ((sameKey && !samePluginPackageArtifact(sameKey, snapshot)) || (!current && !operation.removeData)) {
        throw new Error("Plugin package changed during removal recovery; artifacts were preserved.");
      }
      await deactivatePluginRuntime(snapshot.id, snapshot.pluginKey);
      await ensurePluginWorkerClosed(snapshot.id);
      // Reuse the exact live maintenance permit and path classifier. A journal
      // is never authority to bypass closure or delete an arbitrary local path.
      await pluginLoaderInstance.cleanupInstallArtifacts(snapshot, permit);
      const result = current ? await registry.uninstall(snapshot.id, operation.removeData) as PluginRecord | null : null;
      await packageOperations!.complete(operation.id);
      emitter.emit("plugin.status_changed", { pluginId: snapshot.id, pluginKey: snapshot.pluginKey,
        previousStatus: snapshot.status, newStatus: "uninstalled" as PluginStatus });
      emitDomain("plugin.unloaded", { pluginId: snapshot.id, pluginKey: snapshot.pluginKey, removeData: operation.removeData });
      return result;
    });
  }

  async function ensurePluginWorkerClosed(pluginId: string): Promise<void> {
    if (!workerManager) {
      // Preserve the documented metadata-only mode. A runtime-backed loader
      // without its process owner cannot certify closure. Destructive artifact
      // cleanup separately requires the manager in withArtifactCleanupFence.
      if (typeof pluginLoaderInstance.hasRuntimeServices !== "function"
        || !pluginLoaderInstance.hasRuntimeServices()) return;
      throw new PluginPackageMaintenanceRequiredError();
    }
    // unloadSingle is intentionally best-effort for ordinary lifecycle paths.
    // Package deletion needs a confirmed close, so retry through the manager
    // and refuse to touch artifacts if its exact handle remains registered.
    if (workerManager.getWorker(pluginId)) await workerManager.stopWorker(pluginId);
    if (workerManager.getWorker(pluginId)) throw new PluginPackageMaintenanceRequiredError();
  }

  async function withPluginWorkerStartFence<T>(pluginId: string, action: () => Promise<T>): Promise<T> {
    if (!workerManager) {
      if (typeof pluginLoaderInstance.hasRuntimeServices !== "function"
        || !pluginLoaderInstance.hasRuntimeServices()) return await action();
      throw new PluginPackageMaintenanceRequiredError();
    }
    if (typeof workerManager.withPluginPackageMutation !== "function") {
      throw new PluginPackageMaintenanceRequiredError();
    }
    return await workerManager.withPluginPackageMutation(pluginId, action);
  }

  async function restoreUpgradeSnapshot(
    snapshot: PluginRecord,
    reactivateReadyRuntime: boolean,
    unloadCandidateRuntime: boolean,
  ): Promise<void> {
    const restoreErrors: string[] = [];
    let previousArtifactRestored = false;

    // A failing loader can have registered routes, tools, jobs, or a worker
    // before it reports activation failure. Keep starts fenced and confirm the
    // exact worker is gone before restoring the old package pointer. If closure
    // is uncertain, leave the candidate record in place so it cannot describe
    // a different package than the process that may still be running.
    try {
      await withPluginWorkerStartFence(snapshot.id, async () => {
        await ensurePluginWorkerClosed(snapshot.id);
        if (unloadCandidateRuntime) {
          // A failed unload may leave Host handlers bound to the candidate.
          // Do not restore the old package pointer or reactivate it unless the
          // candidate runtime was fully unloaded and its exact worker closed.
          await deactivatePluginRuntime(snapshot.id, snapshot.pluginKey);
          await ensurePluginWorkerClosed(snapshot.id);
        }

        let restored: PluginRecord | null;
        try {
          restored = await registry.update(snapshot.id, {
            packageName: snapshot.packageName,
            packagePath: snapshot.packagePath,
            version: snapshot.version,
            manifest: snapshot.manifestJson as PaperclipPluginManifestV1,
          }) as PluginRecord | null;
        } catch (error) {
          restoreErrors.push(`registry restore failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!restored) {
          restoreErrors.push("plugin registry record was not found while restoring the previous artifact");
          return;
        }
        try {
          const current = await requirePlugin(snapshot.id);
          if (current.status !== snapshot.status || current.lastError !== snapshot.lastError) {
            await transition(snapshot.id, snapshot.status, snapshot.lastError ?? null, current);
          }
        } catch (error) {
          restoreErrors.push(`status restore failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        previousArtifactRestored = true;
      });
    } catch (error) {
      restoreErrors.push(`candidate runtime closure or rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (reactivateReadyRuntime && previousArtifactRestored) {
      try {
        await activateReadyPlugin(snapshot.id);
      } catch (error) {
        restoreErrors.push(`previous runtime reactivation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (restoreErrors.length > 0) {
      throw new Error(`Upgrade rollback incomplete: ${restoreErrors.join("; ")}`);
    }
  }

  async function failUpgradeWithRollback(
    error: unknown,
    snapshot: PluginRecord,
    reactivateReadyRuntime: boolean,
    unloadCandidateRuntime: boolean,
  ): Promise<never> {
    const originalMessage = error instanceof Error ? error.message : String(error);
    try {
      await restoreUpgradeSnapshot(snapshot, reactivateReadyRuntime, unloadCandidateRuntime);
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      log.error(
        { pluginId: snapshot.id, pluginKey: snapshot.pluginKey, originalMessage, rollbackMessage },
        "plugin lifecycle: upgrade failed and rollback was incomplete",
      );
      throw new Error(`Plugin upgrade failed: ${originalMessage}. ${rollbackMessage}`);
    }

    log.warn(
      { pluginId: snapshot.id, pluginKey: snapshot.pluginKey, originalMessage },
      "plugin lifecycle: upgrade failed and the previous plugin was restored",
    );
    throw error instanceof Error ? error : new Error(originalMessage);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const service: PluginLifecycleManager = {
    async recoverPackageOperations() {
      if (!packageOperations) return;
      // An invalid/unreadable journal fails startup before loadAll. Individual
      // blocked removals stay quarantined and do not stop unrelated plugins.
      for (const operation of await packageOperations.listPending()) {
        try {
          const resume = () => finishDurableUninstall(operation);
          if (workspaceRuntime) await withSpsPluginRuntimeMutation(workspaceRuntime, operation.pluginId, resume);
          else await resume();
        } catch (error) {
          log.error({ pluginId: operation.pluginId, operationId: operation.id, error },
            "plugin lifecycle: package removal recovery remains pending");
        }
      }
    },
    attachRuntimeLoader(loader: PluginLoader): void {
      if (pluginLoaderInstance === loader) return;
      if (runtimeLoaderAttached) {
        throw new Error("Plugin lifecycle runtime loader is already attached.");
      }
      pluginLoaderInstance = loader;
      runtimeLoaderAttached = true;
    },

    // -- load -------------------------------------------------------------
    /**
     * load — Transitions a plugin to 'ready' status and starts its worker.
     *
     * This method is called after a plugin has been successfully installed and
     * validated. It marks the plugin as ready in the database and immediately
     * triggers the plugin loader to start the worker process.
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns The updated plugin record.
     */
    async load(pluginId: string): Promise<PluginRecord> {
      const result = await transition(pluginId, "ready");
      await activateReadyPlugin(pluginId);

      emitDomain("plugin.loaded", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- enable -----------------------------------------------------------
    /**
     * enable — Re-enables a plugin that was previously in an error or upgrade state.
     *
     * Similar to load(), this method transitions the plugin to 'ready' and starts
     * its worker, but it specifically targets plugins that are currently disabled.
     *
     * @param pluginId - The UUID of the plugin to enable.
     * @returns The updated plugin record.
     */
    async enable(pluginId: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      if (plugin.status === "upgrade_pending") {
        throw badRequest(
          "Plugin update is waiting for review. Re-run the upgrade with the required approval instead of enabling it directly.",
        );
      }
      if (plugin.status !== "disabled" && plugin.status !== "error") {
        throw badRequest(
          `Cannot enable plugin in status '${plugin.status}'. Plugin must be in 'disabled' or 'error' status to be enabled.`,
        );
      }

      const result = await transition(pluginId, "ready", null, plugin);
      await activateReadyPlugin(pluginId);
      emitDomain("plugin.enabled", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- disable ----------------------------------------------------------
    async disable(pluginId: string, reason?: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);

      // Only allow disabling from ready state
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot disable plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status to be disabled.`,
        );
      }

      const result = await withPluginWorkerStartFence(pluginId, async () => {
        await ensurePluginWorkerClosed(pluginId);
        await deactivatePluginRuntime(pluginId, plugin.pluginKey);
        await ensurePluginWorkerClosed(pluginId);
        return await transition(pluginId, "disabled", reason ?? null, plugin);
      });
      emitDomain("plugin.disabled", {
        pluginId,
        pluginKey: result.pluginKey,
        reason,
      });
      return result;
    },

    // -- unload -----------------------------------------------------------
    async unload(
      pluginId: string,
      removeData = false,
    ): Promise<PluginRecord | null> {
      if (packageOperations) {
        const pending = await packageOperations.pendingForPlugin(pluginId);
        if (pending) {
          if (pending.removeData !== removeData) throw badRequest("Resume the existing package removal before changing its data policy.");
          return finishDurableUninstall(pending);
        }
        const snapshot = await requirePlugin(pluginId);
        if (snapshot.status === "uninstalled" && !removeData) throw badRequest("Plugin is already uninstalled.");
        // Close inside the existing admission fence before writing durable
        // intent. Failure to persist intent cannot authorize artifact deletion.
        return withArtifactCleanupFence(snapshot, async permit => {
          await deactivatePluginRuntime(pluginId, snapshot.pluginKey);
          await ensurePluginWorkerClosed(pluginId);
          const operation = await packageOperations!.beginUninstall(snapshot, removeData);
          await pluginLoaderInstance.cleanupInstallArtifacts(snapshot, permit);
          const result = await registry.uninstall(pluginId, removeData) as PluginRecord | null;
          await packageOperations!.complete(operation.id);
          emitter.emit("plugin.status_changed", { pluginId, pluginKey: snapshot.pluginKey,
            previousStatus: snapshot.status, newStatus: "uninstalled" as PluginStatus });
          emitDomain("plugin.unloaded", { pluginId, pluginKey: snapshot.pluginKey, removeData });
          return result;
        });
      }
      const plugin = await requirePlugin(pluginId);

      // If already uninstalled and removeData, hard-delete
      if (plugin.status === "uninstalled") {
        if (removeData) {
          return withArtifactCleanupFence(plugin, async (permit) => {
            await deactivatePluginRuntime(pluginId, plugin.pluginKey);
            await ensurePluginWorkerClosed(pluginId);
            await pluginLoaderInstance.cleanupInstallArtifacts(plugin, permit);
            const deleted = await registry.uninstall(pluginId, true);
            log.info(
              { pluginId, pluginKey: plugin.pluginKey },
              "plugin lifecycle: hard-deleted already-uninstalled plugin",
            );
            emitDomain("plugin.unloaded", {
              pluginId,
              pluginKey: plugin.pluginKey,
              removeData: true,
            });
            return deleted as PluginRecord | null;
          });
        }
        throw badRequest(
          `Plugin ${plugin.pluginKey} is already uninstalled. ` +
            `Use removeData=true to permanently delete it.`,
        );
      }

      return withArtifactCleanupFence(plugin, async (permit) => {
        await deactivatePluginRuntime(pluginId, plugin.pluginKey);
        await ensurePluginWorkerClosed(pluginId);
        await pluginLoaderInstance.cleanupInstallArtifacts(plugin, permit);

        // Perform the uninstall via registry (handles soft/hard delete)
        const result = await registry.uninstall(pluginId, removeData);

        log.info(
          { pluginId, pluginKey: plugin.pluginKey, removeData },
          `plugin lifecycle: ${plugin.status} → uninstalled${removeData ? " (hard delete)" : ""}`,
        );

        emitter.emit("plugin.status_changed", {
          pluginId,
          pluginKey: plugin.pluginKey,
          previousStatus: plugin.status,
          newStatus: "uninstalled" as PluginStatus,
        });

        emitDomain("plugin.unloaded", {
          pluginId,
          pluginKey: plugin.pluginKey,
          removeData,
        });

        return result as PluginRecord | null;
      });
    },

    // -- markError --------------------------------------------------------
    async markError(pluginId: string, error: string): Promise<PluginRecord> {
      // Stop the worker — the plugin is in an error state and should not
      // continue running. The worker manager's auto-restart is disabled
      // because we are intentionally taking the plugin offline.
      const plugin = await requirePlugin(pluginId);
      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "error", error, plugin);
      emitDomain("plugin.error", {
        pluginId,
        pluginKey: result.pluginKey,
        error,
      });
      return result;
    },

    // -- markUpgradePending -----------------------------------------------
    async markUpgradePending(pluginId: string): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);
      await deactivatePluginRuntime(pluginId, plugin.pluginKey);

      const result = await transition(pluginId, "upgrade_pending", null, plugin);
      emitDomain("plugin.upgrade_pending", {
        pluginId,
        pluginKey: result.pluginKey,
      });
      return result;
    },

    // -- upgrade ----------------------------------------------------------
    /**
     * Upgrade a plugin to a newer version by performing a package update and
     * managing the lifecycle state transition.
     *
     * Following PLUGIN_SPEC.md §25.3, the upgrade process:
     * 1. Stops the current worker process (if running).
     * 2. Fetches and validates the new plugin package via the `PluginLoader`.
     * 3. Compares the capabilities declared in the new manifest against the old one.
     * 4. If new capabilities are added, transitions the plugin to `upgrade_pending`
     *    to await operator approval (worker stays stopped).
     * 5. If no new capabilities are added, transitions the plugin back to `ready`
     *    with the updated version and manifest metadata.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param version - Optional target version specifier.
     * @returns The updated `PluginRecord`.
     * @throws {BadRequest} If the plugin is not in a ready or upgrade_pending state.
     */
    async upgrade(
      pluginId: string,
      input: string | PluginLifecycleUpgradeOptions = {},
    ): Promise<PluginRecord> {
      const plugin = await requirePlugin(pluginId);
      // Keep an immutable rollback target. Registry implementations normally
      // return fresh records, but lifecycle safety must not depend on that.
      const originalPlugin: PluginRecord = {
        ...plugin,
        manifestJson: structuredClone(plugin.manifestJson),
      };
      const options: PluginLifecycleUpgradeOptions = typeof input === "string"
        ? { version: input }
        : input;

      // A reviewed stage can replace a disabled or errored plugin without
      // starting the old package first. High-risk candidates still stop in
      // upgrade_pending until the Host approves them.
      if (
        plugin.status !== "ready"
        && plugin.status !== "disabled"
        && plugin.status !== "error"
        && plugin.status !== "upgrade_pending"
      ) {
        throw badRequest(
          `Cannot upgrade plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready', 'disabled', 'error', or 'upgrade_pending' status to be upgraded.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey, targetVersion: options.version },
        "plugin lifecycle: upgrade requested",
      );

      // 1. Download and validate the candidate before touching a healthy
      // runtime. The loader stages package artifacts outside the active path.
      const { oldManifest, newManifest, discovered } =
        await pluginLoaderInstance.prepareUpgrade(pluginId, options);

      log.info(
        {
          pluginId,
          pluginKey: plugin.pluginKey,
          oldVersion: oldManifest.version,
          newVersion: newManifest.version,
        },
        "plugin lifecycle: package upgraded on disk",
      );

      // 2. Compare capabilities
      const addedCaps = newManifest.capabilities.filter(
        (cap) => !oldManifest.capabilities.includes(cap),
      );

      const migrationPlan = newManifest.database
        ? await pluginDatabaseService(migrationDb).inspectMigrations(
          pluginId,
          newManifest,
          discovered.packagePath,
        )
        : null;
      const needsCapabilityApproval = addedCaps.length > 0 && !options.approvedCapabilityEscalation;
      const needsDataMigrationApproval = Boolean(
        migrationPlan?.requiresHostApproval
          && options.approvedDataMigrationPlanHash !== migrationPlan.reviewHash,
      );

      // 3. Transition state
      if (needsCapabilityApproval || needsDataMigrationApproval) {
        // New capabilities require operator approval — worker stays stopped
        log.info(
          { pluginId, pluginKey: plugin.pluginKey, addedCaps },
          "plugin lifecycle: new capabilities detected, transitioning to upgrade_pending",
        );
        const reviewReasons = [
          `target version: ${newManifest.version}`,
          ...(needsCapabilityApproval ? [`new capabilities: ${addedCaps.join(", ")}`] : []),
          ...(needsDataMigrationApproval
            ? [`data migration plan: ${migrationPlan!.reviewHash}`]
            : []),
        ];
        let attemptedReadyRuntimeTeardown = false;
        let mutationStarted = false;
        try {
          const result = await withPluginWorkerStartFence(pluginId, async () => {
            if (plugin.status === "ready") {
              // Close before unloading Host handlers. unloadSingle treats a
              // process-stop error as best-effort for ordinary lifecycle use.
              await ensurePluginWorkerClosed(pluginId);
              attemptedReadyRuntimeTeardown = true;
              mutationStarted = true;
              await deactivatePluginRuntime(pluginId, plugin.pluginKey);
            }
            await ensurePluginWorkerClosed(pluginId);
            mutationStarted = true;
            return await transition(
              pluginId,
              "upgrade_pending",
              `Upgrade review required: ${reviewReasons.join("; ")}`,
              plugin,
            );
          });
          emitDomain("plugin.upgrade_pending", {
            pluginId,
            pluginKey: result.pluginKey,
          });
          return result;
        } catch (error) {
          if (!mutationStarted) throw error;
          return await failUpgradeWithRollback(
            error,
            originalPlugin,
            originalPlugin.status === "ready" && attemptedReadyRuntimeTeardown,
            false,
          );
        }
      } else {
        if (migrationPlan?.requiresHostApproval) {
          if (!databaseBackupService) {
            throw badRequest(
              "An approved plugin data migration requires a Host database backup service.",
            );
          }
          const backup = await databaseBackupService.runManualBackup();
          if (!backup.backupFile) {
            throw badRequest("Host backup completed without a backup file reference.");
          }
          log.info(
            {
              pluginId,
              pluginKey: plugin.pluginKey,
              migrationPlanHash: migrationPlan.reviewHash,
              backupFile: backup.backupFile,
            },
            "plugin lifecycle: created Host backup before approved data migration",
          );
        }
        let attemptedReadyRuntimeTeardown = false;
        let candidateRuntimeMayBeActive = false;
        let mutationStarted = false;
        try {
          const result = await withPluginWorkerStartFence(pluginId, async () => {
            if (plugin.status === "ready") {
              // Close before unloading Host handlers. The manager fence keeps
              // a direct Host start from slipping between closure and commit.
              await ensurePluginWorkerClosed(pluginId);
              attemptedReadyRuntimeTeardown = true;
              mutationStarted = true;
              await deactivatePluginRuntime(pluginId, plugin.pluginKey);
            }
            await ensurePluginWorkerClosed(pluginId);
            mutationStarted = true;
            await pluginLoaderInstance.commitPreparedUpgrade(pluginId, {
              oldManifest,
              newManifest,
              discovered,
            });
            const transitioned = await transition(pluginId, "ready", null, {
              ...plugin,
              version: discovered.version,
              manifestJson: newManifest,
            } as PluginRecord);
            candidateRuntimeMayBeActive = true;
            return transitioned;
          });
          await activateReadyPlugin(
            pluginId,
            migrationPlan?.requiresHostApproval ? migrationPlan.reviewHash : undefined,
          );

          emitDomain("plugin.loaded", {
            pluginId,
            pluginKey: result.pluginKey,
          });
          emitDomain("plugin.enabled", {
            pluginId,
            pluginKey: result.pluginKey,
          });

          return result;
        } catch (error) {
          if (!mutationStarted) throw error;
          return await failUpgradeWithRollback(
            error,
            originalPlugin,
            originalPlugin.status === "ready" && attemptedReadyRuntimeTeardown,
            candidateRuntimeMayBeActive,
          );
        }
      }
    },

    // -- startWorker ------------------------------------------------------
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot start worker: no PluginWorkerManager is configured. " +
            "Provide a workerManager option when constructing the lifecycle manager.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot start worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: starting worker",
      );

      await workerManager.startWorker(pluginId, options);
      emitDomain("plugin.worker_started", {
        pluginId,
        pluginKey: plugin.pluginKey,
      });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker started",
      );
    },

    // -- stopWorker -------------------------------------------------------
    async stopWorker(pluginId: string): Promise<void> {
      if (!workerManager) return; // No worker manager — nothing to stop

      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);
    },

    // -- restartWorker ----------------------------------------------------
    async restartWorker(pluginId: string): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot restart worker: no PluginWorkerManager is configured.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw badRequest(
          `Cannot restart worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      const handle = workerManager.getWorker(pluginId);
      if (!handle) {
        throw badRequest(
          `Cannot restart worker for plugin "${plugin.pluginKey}": no worker is running.`,
        );
      }

      const supportsRuntimeActivation =
        typeof pluginLoaderInstance.hasRuntimeServices === "function"
        && typeof pluginLoaderInstance.loadSingle === "function"
        && typeof pluginLoaderInstance.unloadSingle === "function"
        && pluginLoaderInstance.hasRuntimeServices();

      if (supportsRuntimeActivation) {
        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: reloading plugin (re-reading manifest, re-applying pending migrations, restarting worker)",
        );

        // Full deactivate+reactivate cycle (not just `handle.restart()`) so that:
        //   - the manifest is re-read from disk, picking up newly declared
        //     `migrations/*.sql` files and any other manifest changes,
        //   - `applyMigrations` runs idempotently against the up-to-date
        //     migrations directory — pending migrations get applied, already-
        //     applied ones are skipped via the `pluginMigrations` table,
        //   - the worker subprocess is replaced with one loading the freshly
        //     built bundle.
        //
        // Bouncing the worker process alone (`handle.restart()`) leaves plugin
        // schema out of sync with worker code whenever a hot reload adds a new
        // migration, which makes downstream queries fail against missing tables.
        await withPluginWorkerStartFence(pluginId, async () => {
          await ensurePluginWorkerClosed(pluginId);
          await deactivatePluginRuntime(pluginId, plugin.pluginKey);
          await ensurePluginWorkerClosed(pluginId);
        });
        await activateReadyPlugin(pluginId);
      } else {
        // No runtime activation services wired in (e.g. state-only test harness)
        // — fall back to a bare worker subprocess bounce.
        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: restarting worker (runtime services unavailable; skipping migration re-apply)",
        );
        await withPluginWorkerStartFence(pluginId, async () => {
          await handle.stop();
          const diagnostics = handle.diagnostics();
          if (diagnostics.status !== "stopped" || diagnostics.pid !== null) {
            throw new PluginPackageMaintenanceRequiredError();
          }
        });
        // startInternal checks the manager's owner fence, so restarting the
        // retained handle must happen after the package-mutation fence opens.
        if (workerManager.getWorker(pluginId) !== handle) {
          throw new PluginPackageMaintenanceRequiredError();
        }
        await handle.start();
        emitDomain("plugin.worker_stopped", { pluginId, pluginKey: plugin.pluginKey });
        emitDomain("plugin.worker_started", { pluginId, pluginKey: plugin.pluginKey });
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: plugin reloaded",
      );
    },

    // -- getStatus --------------------------------------------------------
    async getStatus(pluginId: string): Promise<PluginStatus | null> {
      const plugin = await registry.getById(pluginId);
      return plugin?.status ?? null;
    },

    // -- canTransition ----------------------------------------------------
    async canTransition(pluginId: string, to: PluginStatus): Promise<boolean> {
      const plugin = await registry.getById(pluginId);
      if (!plugin) return false;
      return isValidTransition(plugin.status, to);
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },

    once(event, listener) {
      emitter.once(event, listener);
    },
  };
  if (!workspaceRuntime && !packageOperations) return service;
  const coordinate = <T>(pluginId: string, operation: () => Promise<T>, resumeRemoval = false) => {
    const guarded = async () => {
      if (!resumeRemoval) await packageOperations?.assertClear(pluginId);
      return operation();
    };
    return workspaceRuntime ? withSpsPluginRuntimeMutation(workspaceRuntime, pluginId, guarded) : guarded();
  };
  // Central coordination also covers development reloads and non-HTTP callers.
  return {
    ...service,
    load: id => coordinate(id, () => service.load(id)),
    enable: id => coordinate(id, () => service.enable(id)),
    disable: (id, reason) => coordinate(id, () => service.disable(id, reason)),
    unload: (id, removeData) => coordinate(id, () => service.unload(id, removeData), true),
    markError: (id, error) => coordinate(id, () => service.markError(id, error)),
    markUpgradePending: id => coordinate(id, () => service.markUpgradePending(id)),
    upgrade: (id, options) => coordinate(id, () => service.upgrade(id, options)),
    restartWorker: id => coordinate(id, () => service.restartWorker(id)),
    startWorker: (id, options) => coordinate(id, () => service.startWorker(id, options)),
  };
}
