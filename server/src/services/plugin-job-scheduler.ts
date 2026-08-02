/**
 * PluginJobScheduler — tick-based scheduler for plugin scheduled jobs.
 *
 * The scheduler is the central coordinator for all plugin cron jobs. It
 * periodically ticks (default every 30 seconds), queries the `plugin_jobs`
 * table for jobs whose `nextRunAt` has passed, dispatches `runJob` RPC calls
 * to the appropriate worker processes, records each execution in the
 * `plugin_job_runs` table, and advances the scheduling pointer.
 *
 * ## Responsibilities
 *
 * 1. **Tick loop** — A `setInterval`-based loop fires every `tickIntervalMs`
 *    (default 30s). Each tick scans for due jobs and dispatches them.
 *
 * 2. **Cron parsing & next-run calculation** — Uses the lightweight built-in
 *    cron parser ({@link parseCron}, {@link nextCronTick}) to compute the
 *    `nextRunAt` timestamp after each run or when a new job is registered.
 *
 * 3. **Overlap prevention** — Before dispatching a job, the scheduler checks
 *    for an existing `running` run for the same job. If one exists, the job
 *    is skipped for that tick.
 *
 * 4. **Job run recording** — Every execution creates a `plugin_job_runs` row:
 *    `queued` → `running` → `succeeded` | `failed`. Duration and error are
 *    captured.
 *
 * 5. **Lifecycle integration** — The scheduler exposes `registerPlugin()` and
 *    `unregisterPlugin()` so the host lifecycle manager can wire up job
 *    scheduling when plugins start/stop. On registration, the scheduler
 *    computes `nextRunAt` for all active jobs that don't already have one.
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./cron.ts — Cron parsing utilities
 */

import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, pluginCompanySettings, pluginJobs, pluginJobRuns, plugins } from "@paperclipai/db";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { parseCron, nextCronTick, validateCron } from "./cron.js";
import { logger } from "../middleware/logger.js";
import { analyzePluginDependencies, isPluginDependencyAvailable } from "./plugin-dependencies.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval between scheduler ticks (30 seconds). */
const DEFAULT_TICK_INTERVAL_MS = 30_000;

/** Default timeout for a runJob RPC call (5 minutes). */
const DEFAULT_JOB_TIMEOUT_MS = 5 * 60 * 1_000;

/** Maximum number of concurrent job executions across all plugins. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobScheduler.
 */
export interface PluginJobSchedulerOptions {
  /** Drizzle database instance. */
  db: Db;
  /** Persistence layer for jobs and runs. */
  jobStore: PluginJobStore;
  /** Worker process manager for RPC calls. */
  workerManager: PluginWorkerManager;
  /** Interval between scheduler ticks in ms (default: 30s). */
  tickIntervalMs?: number;
  /** Timeout for individual job RPC calls in ms (default: 5min). */
  jobTimeoutMs?: number;
  /** Maximum number of concurrent job executions (default: 10). */
  maxConcurrentJobs?: number;
}

/**
 * Result of a manual job trigger.
 */
export interface TriggerJobResult {
  /** The created run ID. */
  runId: string;
  /** The job ID that was triggered. */
  jobId: string;
}

/**
 * Diagnostic information about the scheduler.
 */
export interface SchedulerDiagnostics {
  /** Whether the tick loop is running. */
  running: boolean;
  /** Number of jobs currently executing. */
  activeJobCount: number;
  /** Set of job IDs currently in-flight. */
  activeJobIds: string[];
  /** Total number of ticks executed since start. */
  tickCount: number;
  /** Timestamp of the last tick (ISO 8601). */
  lastTickAt: string | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * The public interface of the job scheduler.
 */
export interface PluginJobScheduler {
  /**
   * Start the scheduler tick loop.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  start(): void;

  /**
   * Stop the scheduler tick loop.
   *
   * In-flight job runs are NOT cancelled — they are allowed to finish
   * naturally. The tick loop simply stops firing.
   */
  stop(): void;

  /**
   * Register a plugin with the scheduler.
   *
   * Computes `nextRunAt` for all active jobs that are missing it. This is
   * typically called after a plugin's worker process starts and
   * `syncJobDeclarations()` has been called.
   *
   * @param pluginId - UUID of the plugin
   */
  registerPlugin(pluginId: string): Promise<void>;

  /**
   * Unregister a plugin from the scheduler.
   *
   * Cancels any in-flight runs for the plugin and removes tracking state.
   *
   * @param pluginId - UUID of the plugin
   */
  unregisterPlugin(pluginId: string): Promise<void>;

  /**
   * Manually trigger a specific job (outside of the cron schedule).
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately,
   * respecting the overlap prevention check.
   *
   * @param jobId - UUID of the job to trigger
   * @param trigger - What triggered this run (default: "manual")
   * @returns The created run info
   * @throws {Error} if the job is not found, not active, or already running
   */
  triggerJob(jobId: string, trigger?: "manual" | "retry", companyId?: string | null): Promise<TriggerJobResult>;
  cancelRun(runId: string, reason?: string): Promise<boolean>;
  retryRun(runId: string): Promise<TriggerJobResult>;

  /**
   * Run a single scheduler tick immediately (for testing).
   *
   * @internal
   */
  tick(): Promise<void>;

  /**
   * Get diagnostic information about the scheduler state.
   */
  diagnostics(): SchedulerDiagnostics;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a new PluginJobScheduler.
 *
 * @example
 * ```ts
 * const scheduler = createPluginJobScheduler({
 *   db,
 *   jobStore,
 *   workerManager,
 * });
 *
 * // Start the tick loop
 * scheduler.start();
 *
 * // When a plugin comes online, register it
 * await scheduler.registerPlugin(pluginId);
 *
 * // Manually trigger a job
 * const { runId } = await scheduler.triggerJob(jobId);
 *
 * // On server shutdown
 * scheduler.stop();
 * ```
 */
export function createPluginJobScheduler(
  options: PluginJobSchedulerOptions,
): PluginJobScheduler {
  const {
    db,
    jobStore,
    workerManager,
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
    maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS,
  } = options;

  const log = logger.child({ service: "plugin-job-scheduler" });

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Timer handle for the tick loop. */
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the scheduler is running. */
  let running = false;

  /** Set of job/company execution keys currently being executed. */
  const activeJobs = new Set<string>();
  /** Live dispatch promises, used to honour the global bounded concurrency
   * limit without losing a workspace occurrence. */
  const activeExecutions = new Map<string, Promise<void>>();

  /** Total number of ticks since start. */
  let tickCount = 0;

  /** Timestamp of the last tick. */
  let lastTickAt: Date | null = null;

  /** Guard against concurrent tick execution. */
  let tickInProgress = false;

  function executionKey(jobId: string, companyId: string | null): string {
    return `${jobId}:${companyId ?? "host"}`;
  }

  function companyCondition(companyId: string | null) {
    return companyId === null ? isNull(pluginJobRuns.companyId) : eq(pluginJobRuns.companyId, companyId);
  }

  function trackDispatch(key: string, dispatch: Promise<void>): Promise<void> {
    activeExecutions.set(key, dispatch);
    void dispatch.then(
      () => { activeExecutions.delete(key); },
      () => { activeExecutions.delete(key); },
    );
    return dispatch;
  }

  async function waitForCapacity(): Promise<void> {
    while (activeJobs.size >= maxConcurrentJobs) {
      const active = [...activeExecutions.values()];
      // Every Core dispatch is tracked. The fallback protects a malformed
      // integration from spinning forever and leaves the occurrence due.
      if (active.length === 0) throw new Error("scheduler capacity is occupied by an untracked run");
      await Promise.race(active);
    }
  }

  async function enabledCompanyIds(pluginId: string): Promise<string[]> {
    const [plugin] = await db.select({ manifestJson: plugins.manifestJson }).from(plugins).where(eq(plugins.id, pluginId));
    if (!plugin) return [];
    const defaultEnabled = plugin.manifestJson.companyActivation?.defaultEnabled ?? true;
    const rows = await db.select({ id: companies.id, enabled: pluginCompanySettings.enabled })
      .from(companies)
      .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.companyId, companies.id), eq(pluginCompanySettings.pluginId, pluginId)))
      .where(eq(companies.status, "active"));
    const enabled = rows.filter((row) => row.enabled ?? defaultEnabled).map((row) => row.id);
    const available = await Promise.all(enabled.map(async (companyId) => ({ companyId, available: await pluginDependencyAvailable(pluginId, companyId) })));
    return available.filter((entry) => entry.available).map((entry) => entry.companyId);
  }

  async function pluginDependencyAvailable(pluginId: string, companyId: string | null): Promise<boolean> {
    const records = companyId
      ? await db.select({ plugin: plugins, enabled: pluginCompanySettings.enabled })
        .from(plugins)
        .leftJoin(pluginCompanySettings, and(eq(pluginCompanySettings.pluginId, plugins.id), eq(pluginCompanySettings.companyId, companyId)))
      : (await db.select({ plugin: plugins }).from(plugins)).map((row) => ({ ...row, enabled: undefined }));
    const target = records.find((row) => row.plugin.id === pluginId)?.plugin;
    if (!target || target.status !== "ready") return false;
    const report = analyzePluginDependencies(records.map((row) => ({
      id: row.plugin.id,
      version: row.plugin.version,
      manifest: row.plugin.manifestJson,
      available: row.plugin.status === "ready",
      active: row.plugin.status === "ready" && (companyId === null || (row.enabled ?? row.plugin.manifestJson.companyActivation?.defaultEnabled ?? true)),
    })));
    return isPluginDependencyAvailable(report, target.manifestJson.id);
  }

  // -----------------------------------------------------------------------
  // Core: tick
  // -----------------------------------------------------------------------

  /**
   * A single scheduler tick. Queries for due jobs and dispatches them.
   */
  async function tick(): Promise<void> {
    // Prevent overlapping ticks (in case a tick takes longer than the interval)
    if (tickInProgress) {
      log.debug("skipping tick — previous tick still in progress");
      return;
    }

    tickInProgress = true;
    tickCount++;
    lastTickAt = new Date();

    try {
      const now = new Date();

      // Query for jobs whose nextRunAt has passed and are active.
      // We include jobs with null nextRunAt since they may have just been
      // registered and need their first run calculated.
      const dueJobs = await db
        .select()
        .from(pluginJobs)
        .where(
          and(
            eq(pluginJobs.status, "active"),
            lte(pluginJobs.nextRunAt, now),
          ),
        );

      if (dueJobs.length === 0) {
        return;
      }

      log.debug({ count: dueJobs.length }, "found due jobs");

      // Dispatch each due job (respecting concurrency limits)
      const dispatches: Promise<void>[] = [];

      for (const job of dueJobs) {
        // Concurrency limit
        if (activeJobs.size >= maxConcurrentJobs) {
          log.warn(
            { maxConcurrentJobs, activeJobCount: activeJobs.size },
            "max concurrent jobs reached, deferring remaining jobs",
          );
          break;
        }

        // Overlap prevention: skip if this job is already running
        // Check if the worker is available
        if (!workerManager.isRunning(job.pluginId)) {
          log.debug(
            { jobId: job.id, pluginId: job.pluginId },
            "skipping job — worker not running",
          );
          continue;
        }

        // Validate cron expression before dispatching
        if (!job.schedule) {
          log.warn(
            { jobId: job.id, jobKey: job.jobKey },
            "skipping job — no schedule defined",
          );
          continue;
        }

        const targets = job.scope === "workspace"
          ? await enabledCompanyIds(job.pluginId)
          : [null];
        if (job.scope === "host" && !await pluginDependencyAvailable(job.pluginId, null)) {
          await advanceSchedulePointer(job);
          continue;
        }
        if (targets.length === 0) {
          await advanceSchedulePointer(job);
          continue;
        }
        const targetDispatches: Promise<void>[] = [];
        for (const companyId of targets) {
          const key = executionKey(job.id, companyId);
          // An active target owns this occurrence already. We do not create a
          // duplicate run, while other companies remain eligible.
          if (activeJobs.has(key)) continue;
          await waitForCapacity();
          targetDispatches.push(trackDispatch(key, dispatchJob(job, companyId)));
        }
        // A schedule advances only after every selected company target has
        // been accepted for processing. This prevents a disabled/slow tenant
        // from being silently skipped by a global definition pointer.
        dispatches.push(Promise.allSettled(targetDispatches).then(async () => {
          // Every target was either dispatched or was already processing the
          // same occurrence. Advancing once prevents completed tenants from
          // being re-dispatched on the next tick.
          await advanceSchedulePointer(job);
        }));
      }

      if (dispatches.length > 0) {
        await Promise.allSettled(dispatches);
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "scheduler tick error",
      );
    } finally {
      tickInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Core: dispatch a single job
  // -----------------------------------------------------------------------

  /**
   * Dispatch a single job run — create the run record, call the worker,
   * record the result, and advance the schedule pointer.
   */
  async function dispatchJob(
    job: typeof pluginJobs.$inferSelect,
    companyId: string | null,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey, schedule } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey });

    // Mark as active (overlap prevention)
    const activeKey = executionKey(jobId, companyId);
    activeJobs.add(activeKey);

    let runId: string | undefined;
    const startedAt = Date.now();

    try {
      // 1. Create run record
      const run = await jobStore.createRun({
        jobId,
        pluginId,
        trigger: "schedule",
        companyId,
      });
      runId = run.id;

      jobLog.info({ runId }, "dispatching scheduled job");

      // 2. Mark run as running
      if (!await jobStore.markRunning(runId)) return;

      // 3. Call worker via RPC
      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger: "schedule" as const,
            scheduledAt: (job.nextRunAt ?? new Date()).toISOString(),
            ...(companyId ? { companyId } : {}),
          },
        },
        jobTimeoutMs,
      );

      // 4. Mark run as succeeded
      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ runId, durationMs }, "job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);

      jobLog.error(
        { runId, durationMs, err: errorMessage },
        "job execution failed",
      );

      // Record the failure
      if (runId) {
        try {
          await jobStore.completeRun(runId, {
            status: "failed",
            error: errorMessage,
            durationMs,
          });
        } catch (completeErr) {
          jobLog.error(
            {
              runId,
              err: completeErr instanceof Error ? completeErr.message : String(completeErr),
            },
            "failed to record job failure",
          );
        }
      }
    } finally {
      // Remove from active set
      activeJobs.delete(activeKey);
    }
  }

  // -----------------------------------------------------------------------
  // Core: manual trigger
  // -----------------------------------------------------------------------

  async function triggerJob(
    jobId: string,
    trigger: "manual" | "retry" = "manual",
    companyId?: string | null,
  ): Promise<TriggerJobResult> {
    const job = await jobStore.getJobById(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== "active") {
      throw new Error(
        `Job "${job.jobKey}" is not active (status: ${job.status})`,
      );
    }

    const effectiveCompanyId: string | null = job.scope === "workspace"
      ? (companyId ?? null)
      : null;
    if (job.scope === "workspace" && !effectiveCompanyId) {
      throw new Error(`Workspace job "${job.jobKey}" requires a companyId`);
    }
    if (job.scope !== "workspace" && companyId) {
      throw new Error(`Host job "${job.jobKey}" does not accept a companyId`);
    }
    if (job.scope === "workspace" && !(await enabledCompanyIds(job.pluginId)).includes(effectiveCompanyId!)) {
      throw new Error(`Plugin is disabled or Company is unavailable for "${job.jobKey}"`);
    }
    if (!await pluginDependencyAvailable(job.pluginId, effectiveCompanyId)) {
      throw new Error(`Plugin dependency graph is blocked for "${job.jobKey}"`);
    }
    const activeKey = executionKey(jobId, effectiveCompanyId);
    if (activeJobs.has(activeKey)) {
      throw new Error(
        `Job "${job.jobKey}" is already running — cannot trigger while in progress`,
      );
    }

    // Also check DB for running runs (defensive — covers multi-instance)
    const existingRuns = await db
      .select()
      .from(pluginJobRuns)
      .where(
        and(
          eq(pluginJobRuns.jobId, jobId),
          eq(pluginJobRuns.status, "running"),
          companyCondition(effectiveCompanyId),
        ),
      );

    if (existingRuns.length > 0) {
      throw new Error(
        `Job "${job.jobKey}" already has a running execution — cannot trigger while in progress`,
      );
    }

    // Check worker availability
    if (!workerManager.isRunning(job.pluginId)) {
      throw new Error(
        `Worker for plugin "${job.pluginId}" is not running — cannot trigger job`,
      );
    }

    // Create the run and dispatch (non-blocking)
    const run = await jobStore.createRun({
      jobId,
      pluginId: job.pluginId,
      trigger,
      companyId: effectiveCompanyId,
    });

    // Dispatch in background — don't block the caller
    void trackDispatch(
      executionKey(job.id, effectiveCompanyId),
      dispatchManualRun(job, run.id, trigger, effectiveCompanyId),
    );

    return { runId: run.id, jobId };
  }

  /**
   * Dispatch a manually triggered job run.
   */
  async function dispatchManualRun(
    job: typeof pluginJobs.$inferSelect,
    runId: string,
    trigger: "manual" | "retry",
    companyId: string | null,
  ): Promise<void> {
    const { id: jobId, pluginId, jobKey } = job;
    const jobLog = log.child({ jobId, pluginId, jobKey, runId, trigger });

    const activeKey = executionKey(jobId, companyId);
    activeJobs.add(activeKey);
    const startedAt = Date.now();

    try {
      if (!await jobStore.markRunning(runId)) return;

      await workerManager.call(
        pluginId,
        "runJob",
        {
          job: {
            jobKey,
            runId,
            trigger,
            scheduledAt: new Date().toISOString(),
            ...(companyId ? { companyId } : {}),
          },
        },
        jobTimeoutMs,
      );

      const durationMs = Date.now() - startedAt;
      await jobStore.completeRun(runId, {
        status: "succeeded",
        durationMs,
      });

      jobLog.info({ durationMs }, "manual job completed successfully");
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobLog.error({ durationMs, err: errorMessage }, "manual job failed");

      try {
        await jobStore.completeRun(runId, {
          status: "failed",
          error: errorMessage,
          durationMs,
        });
      } catch (completeErr) {
        jobLog.error(
          {
            err: completeErr instanceof Error ? completeErr.message : String(completeErr),
          },
          "failed to record manual job failure",
        );
      }
    } finally {
      activeJobs.delete(activeKey);
    }
  }

  async function cancelRun(runId: string, reason = "Cancelled by operator"): Promise<boolean> {
    return jobStore.cancelRun(runId, reason);
  }

  async function retryRun(runId: string): Promise<TriggerJobResult> {
    const run = await jobStore.getRunById(runId);
    if (!run) throw new Error(`Job run not found: ${runId}`);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new Error("Only failed or cancelled job runs can be retried");
    }
    return triggerJob(run.jobId, "retry", run.companyId);
  }

  // -----------------------------------------------------------------------
  // Schedule pointer management
  // -----------------------------------------------------------------------

  /**
   * Advance the `lastRunAt` and `nextRunAt` timestamps on a job after a run.
   */
  async function advanceSchedulePointer(
    job: typeof pluginJobs.$inferSelect,
  ): Promise<void> {
    const now = new Date();
    let nextRunAt: Date | null = null;

    if (job.schedule) {
      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, schedule: job.schedule, error: validationError },
          "invalid cron schedule — cannot compute next run",
        );
      } else {
        const cron = parseCron(job.schedule);
        nextRunAt = nextCronTick(cron, now);
      }
    }

    await jobStore.updateRunTimestamps(job.id, now, nextRunAt);
  }

  /**
   * Ensure all active jobs for a plugin have a `nextRunAt` value.
   * Called when a plugin is registered with the scheduler.
   */
  async function ensureNextRunTimestamps(pluginId: string): Promise<void> {
    const jobs = await jobStore.listJobs(pluginId, "active");

    for (const job of jobs) {
      // Skip jobs that already have a valid nextRunAt in the future
      if (job.nextRunAt && job.nextRunAt.getTime() > Date.now()) {
        continue;
      }

      // Skip jobs without a schedule
      if (!job.schedule) {
        continue;
      }

      const validationError = validateCron(job.schedule);
      if (validationError) {
        log.warn(
          { jobId: job.id, jobKey: job.jobKey, schedule: job.schedule, error: validationError },
          "skipping job with invalid cron schedule",
        );
        continue;
      }

      const cron = parseCron(job.schedule);
      const nextRunAt = nextCronTick(cron, new Date());

      if (nextRunAt) {
        await jobStore.updateRunTimestamps(
          job.id,
          job.lastRunAt ?? new Date(0),
          nextRunAt,
        );
        log.debug(
          { jobId: job.id, jobKey: job.jobKey, nextRunAt: nextRunAt.toISOString() },
          "computed nextRunAt for job",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Plugin registration
  // -----------------------------------------------------------------------

  async function registerPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "registering plugin with job scheduler");
    await ensureNextRunTimestamps(pluginId);
  }

  async function unregisterPlugin(pluginId: string): Promise<void> {
    log.info({ pluginId }, "unregistering plugin from job scheduler");

    // Cancel any in-flight run records for this plugin that are still
    // queued or running. Active jobs in-memory will finish naturally.
    try {
      const runningRuns = await db
        .select()
        .from(pluginJobRuns)
        .where(
          and(
            eq(pluginJobRuns.pluginId, pluginId),
            or(
              eq(pluginJobRuns.status, "running"),
              eq(pluginJobRuns.status, "queued"),
            ),
          ),
        );

      for (const run of runningRuns) {
        await jobStore.completeRun(run.id, {
          status: "cancelled",
          error: "Plugin unregistered",
          durationMs: run.startedAt
            ? Date.now() - run.startedAt.getTime()
            : null,
        });
      }
    } catch (err) {
      log.error(
        {
          pluginId,
          err: err instanceof Error ? err.message : String(err),
        },
        "error cancelling in-flight runs during unregister",
      );
    }

    // Remove any active tracking for jobs owned by this plugin
    const jobs = await jobStore.listJobs(pluginId);
    for (const job of jobs) {
      const prefix = `${job.id}:`;
      for (const key of activeJobs) if (key.startsWith(prefix)) activeJobs.delete(key);
      for (const key of activeExecutions.keys()) if (key.startsWith(prefix)) activeExecutions.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle: start / stop
  // -----------------------------------------------------------------------

  function start(): void {
    if (running) {
      log.debug("scheduler already running");
      return;
    }

    running = true;
    // Restart recovery is intentionally state-level. Workers may have died
    // with the prior process, and the worker RPC protocol has no cooperative
    // cancel method; late completions are ignored by conditional transitions.
    void jobStore.recoverStaleRuns("Cancelled during SPS restart recovery")
      .then((count) => { if (count > 0) log.warn({ count }, "recovered stale plugin job runs"); })
      .catch((err) => log.error({ err: err instanceof Error ? err.message : String(err) }, "plugin job stale-run recovery failed"));
    tickTimer = setInterval(() => {
      void tick();
    }, tickIntervalMs);

    log.info(
      { tickIntervalMs, maxConcurrentJobs },
      "plugin job scheduler started",
    );
  }

  function stop(): void {
    // Always clear the timer defensively, even if `running` is already false,
    // to prevent leaked interval timers.
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }

    if (!running) return;
    running = false;

    log.info(
      { activeJobCount: activeJobs.size },
      "plugin job scheduler stopped",
    );
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  function diagnostics(): SchedulerDiagnostics {
    return {
      running,
      activeJobCount: activeJobs.size,
      activeJobIds: [...activeJobs],
      tickCount,
      lastTickAt: lastTickAt?.toISOString() ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start,
    stop,
    registerPlugin,
    unregisterPlugin,
    triggerJob,
    cancelRun,
    retryRun,
    tick,
    diagnostics,
  };
}
