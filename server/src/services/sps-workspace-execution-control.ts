import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, companies, heartbeatRuns, pluginJobRuns, spsModelRuns, spsNodeCommands,
  spsPluginNodeRuns, spsWorkspaceExecutionControl, type Db,
} from "../compat/paperclip/db.js";
import { conflict, notFound } from "../errors.js";

export type SpsWorkspaceExecutionDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SpsWorkspaceExecutionState = "running" | "paused" | "stopped";
export type SpsWorkspaceExecutionSnapshot = Readonly<{
  state: SpsWorkspaceExecutionState; epoch: string; revision: number; updatedAt: string | null;
}>;
type StopHandler = (companyId: string, reason: string, stoppedEpoch: string) => Promise<void>;
type PluginPendingObserver = (companyId: string) => number;
const stopHandlers = new WeakMap<object, Map<string, StopHandler>>();
const pluginPendingObservers = new WeakMap<object, Map<string, PluginPendingObserver>>();
const stopping = new WeakMap<object, Map<string, Promise<void>>>();
const canonicalEpoch = /^(?:0|[1-9][0-9]*)$/;

function epochValue(value: string | null | undefined) {
  const epoch = value ?? "0";
  if (!canonicalEpoch.test(epoch)) throw conflict("Workspace execution generation is invalid.");
  return epoch;
}

function snapshot(row?: typeof spsWorkspaceExecutionControl.$inferSelect): SpsWorkspaceExecutionSnapshot {
  if (row && !["running", "paused", "stopped"].includes(row.state)) {
    throw conflict("Workspace execution state is invalid.");
  }
  return Object.freeze({ state: row?.state ?? "running", epoch: epochValue(row?.epoch),
    revision: row?.revision ?? 0, updatedAt: row?.updatedAt.toISOString() ?? null });
}

export async function getSpsWorkspaceExecutionControl(db: SpsWorkspaceExecutionDb, companyId: string) {
  const [row] = await db.select().from(spsWorkspaceExecutionControl)
    .where(eq(spsWorkspaceExecutionControl.companyId, companyId));
  return snapshot(row);
}

/** All admission/transition transactions take this row before resource/run locks. */
export async function lockSpsWorkspaceExecutionControl(db: SpsWorkspaceExecutionDb, companyId: string) {
  const [workspace] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!workspace) throw notFound("Workspace not found.");
  await db.insert(spsWorkspaceExecutionControl).values({ companyId }).onConflictDoNothing();
  const [row] = await db.select().from(spsWorkspaceExecutionControl)
    .where(eq(spsWorkspaceExecutionControl.companyId, companyId)).for("update");
  if (!row) throw notFound("Workspace not found.");
  return snapshot(row);
}

export async function withSpsWorkspaceExecutionAdmission<T>(
  db: SpsWorkspaceExecutionDb, companyId: string,
  action: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0], epoch: string) => Promise<T>,
): Promise<T> {
  const admit = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => {
    const control = await lockSpsWorkspaceExecutionControl(tx, companyId);
    const [workspace] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
    if (!workspace) throw notFound("Workspace not found.");
    if (control.state !== "running" || workspace.status !== "active") {
      throw conflict("Workspace is not accepting execution.", { code: "workspace_execution_closed" });
    }
    return action(tx, control.epoch);
  };
  // A Native request already owns a transaction and its authority fences.
  // Keep admission in that transaction rather than publishing a nested effect.
  return "$client" in db ? db.transaction(admit) : admit(db);
}

/** Pause permits already running work; stop invalidates its captured generation. */
export async function assertSpsWorkspaceExecutionActive(
  db: SpsWorkspaceExecutionDb, companyId: string, capturedEpoch: string | null | undefined,
) {
  const control = await getSpsWorkspaceExecutionControl(db, companyId);
  if (control.state === "stopped" || control.epoch !== epochValue(capturedEpoch)) {
    throw conflict("Workspace execution has been stopped.", { code: "workspace_execution_stopped" });
  }
}

/** Only the latest owner of a lane may unregister its callback. */
export function registerSpsWorkspaceExecutionStopHandler(db: SpsWorkspaceExecutionDb, lane: string, handler: StopHandler,
  observePluginPending?: PluginPendingObserver) {
  // A few compatibility route tests construct the heartbeat service without a
  // database because they exercise only public routing/auth behavior. There is
  // no durable stop fanout to register for that fixture; production callers
  // always provide the actual Db object.
  if (db == null) return () => {};
  let handlers = stopHandlers.get(db);
  if (!handlers) { handlers = new Map(); stopHandlers.set(db, handlers); }
  handlers.set(lane, handler);
  let observers = pluginPendingObservers.get(db);
  if (!observers) { observers = new Map(); pluginPendingObservers.set(db, observers); }
  if (observePluginPending) observers.set(lane, observePluginPending);
  else observers.delete(lane);
  return () => {
    if (handlers?.get(lane) !== handler) return;
    handlers.delete(lane);
    if (observers?.get(lane) === observePluginPending) observers.delete(lane);
  };
}

/** Actual local Plugin resources supplement durable Node Plugin run counts. */
export function getSpsWorkspaceExecutionLocalPluginPending(db: SpsWorkspaceExecutionDb, companyId: string): number {
  let pending = 0;
  for (const observe of pluginPendingObservers.get(db)?.values() ?? []) {
    const value = observe(companyId);
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(pending + value)) {
      throw conflict("Workspace Plugin resource state is unavailable.");
    }
    pending += value;
  }
  return pending;
}

async function persistStopIntent(tx: SpsWorkspaceExecutionDb, companyId: string, stoppedEpoch: string) {
  const now = new Date(), reason = "Workspace execution was stopped.";
  const older = (column: typeof heartbeatRuns.workspaceExecutionEpoch | typeof spsNodeCommands.workspaceExecutionEpoch
    | typeof spsPluginNodeRuns.workspaceExecutionEpoch | typeof spsModelRuns.workspaceExecutionEpoch | typeof pluginJobRuns.workspaceExecutionEpoch) =>
    sql`${column}::numeric < ${stoppedEpoch}::numeric`;
  await tx.update(spsNodeCommands).set({ status: "cancelled", error: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(spsNodeCommands.companyId, companyId), older(spsNodeCommands.workspaceExecutionEpoch), eq(spsNodeCommands.status, "queued")));
  await tx.update(spsNodeCommands).set({ status: "cancelling", error: reason, updatedAt: now })
    .where(and(eq(spsNodeCommands.companyId, companyId), older(spsNodeCommands.workspaceExecutionEpoch), inArray(spsNodeCommands.status, ["claimed", "running"])));
  await tx.update(spsPluginNodeRuns).set({ status: "cancelled", error: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(spsPluginNodeRuns.companyId, companyId), older(spsPluginNodeRuns.workspaceExecutionEpoch), eq(spsPluginNodeRuns.status, "queued")));
  await tx.update(spsPluginNodeRuns).set({ status: "cancelling", error: reason, updatedAt: now })
    .where(and(eq(spsPluginNodeRuns.companyId, companyId), older(spsPluginNodeRuns.workspaceExecutionEpoch), inArray(spsPluginNodeRuns.status, ["claimed", "running"])));
  await tx.update(pluginJobRuns).set({ status: "cancelled", cancellationRequestedAt: now, error: reason, finishedAt: now })
    .where(and(eq(pluginJobRuns.companyId, companyId), older(pluginJobRuns.workspaceExecutionEpoch), inArray(pluginJobRuns.status, ["pending", "queued"])));
  await tx.update(pluginJobRuns).set({ status: "cancelling", cancellationRequestedAt: now, error: reason })
    .where(and(eq(pluginJobRuns.companyId, companyId), older(pluginJobRuns.workspaceExecutionEpoch), eq(pluginJobRuns.status, "running")));
  await tx.update(spsModelRuns).set({ status: "cancelled", cancellationRequestedAt: now, errorCode: "cancelled", resourcePending: false,
    finishedAt: now, updatedAt: now })
    .where(and(eq(spsModelRuns.companyId, companyId), older(spsModelRuns.workspaceExecutionEpoch), eq(spsModelRuns.status, "queued")));
  await tx.update(spsModelRuns).set({ cancellationRequestedAt: now, updatedAt: now })
    .where(and(eq(spsModelRuns.companyId, companyId), older(spsModelRuns.workspaceExecutionEpoch), eq(spsModelRuns.status, "running")));
  await tx.update(heartbeatRuns).set({ status: "cancelled", error: reason, errorCode: "cancelled", finishedAt: now, updatedAt: now,
    contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || '{"spsSessionCancellationRequested":true,"spsSessionCancellationWasQueued":true,"spsSessionCancellationTermination":"confirmed"}'::jsonb` })
    .where(and(eq(heartbeatRuns.companyId, companyId), older(heartbeatRuns.workspaceExecutionEpoch), eq(heartbeatRuns.status, "queued")));
  await tx.update(heartbeatRuns).set({ updatedAt: now,
    contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || '{"spsSessionCancellationRequested":true,"spsSessionCancellationTermination":"pending"}'::jsonb` })
    .where(and(eq(heartbeatRuns.companyId, companyId), older(heartbeatRuns.workspaceExecutionEpoch), inArray(heartbeatRuns.status, ["running", "cancelling"])));
  await tx.update(agentWakeupRequests).set({ status: "cancelled", error: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
}

export async function getSpsWorkspaceExecutionPending(db: SpsWorkspaceExecutionDb, companyId: string) {
  const [agents, jobs, models, commands, plugins] = await Promise.all([
    db.select({ value: count() }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), or(
      inArray(heartbeatRuns.status, ["queued", "running", "cancelling"]),
      and(sql`${heartbeatRuns.contextSnapshot}->>'spsSessionCancellationRequested' = 'true'`,
        sql`${heartbeatRuns.contextSnapshot}->>'spsSessionCancellationTermination' is distinct from 'confirmed'`),
    ))),
    db.select({ value: count() }).from(pluginJobRuns).where(and(eq(pluginJobRuns.companyId, companyId), inArray(pluginJobRuns.status, ["pending", "queued", "running", "cancelling"]))),
    db.select({ value: count() }).from(spsModelRuns).where(and(eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.resourcePending, true))),
    db.select({ value: count() }).from(spsNodeCommands).where(and(eq(spsNodeCommands.companyId, companyId), inArray(spsNodeCommands.status, ["queued", "claimed", "running", "cancelling"]))),
    db.select({ value: count() }).from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.companyId, companyId), inArray(spsPluginNodeRuns.status, ["queued", "claimed", "running", "cancelling"]))),
  ]);
  return Object.freeze({ agents: Number(agents[0]?.value ?? 0), jobs: Number(jobs[0]?.value ?? 0),
    models: Number(models[0]?.value ?? 0), commands: Number(commands[0]?.value ?? 0),
    plugins: Number(plugins[0]?.value ?? 0) + getSpsWorkspaceExecutionLocalPluginPending(db, companyId) });
}

export function spsWorkspaceExecutionControlService(db: Db) {
  return {
    async get(companyId: string) {
      const [workspace] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      if (!workspace) throw notFound("Workspace not found.");
      return { ...await getSpsWorkspaceExecutionControl(db, companyId), pending: await getSpsWorkspaceExecutionPending(db, companyId) };
    },
    async transition(companyId: string, action: "pause" | "stop" | "resume", actorUserId: string, expectedRevision: number) {
      const control = await db.transaction(async tx => {
        const prior = await lockSpsWorkspaceExecutionControl(tx, companyId);
        if (prior.revision !== expectedRevision) throw conflict("Workspace execution state changed. Refresh before retrying.");
        if (action === "pause" && prior.state === "stopped") throw conflict("Resume the stopped Workspace before pausing it.");
        const state = action === "resume" ? "running" : action === "pause" ? "paused" : "stopped";
        if (state === prior.state) {
          if (action === "stop") await persistStopIntent(tx, companyId, prior.epoch);
          return prior;
        }
        const epoch = action === "stop" ? String(BigInt(prior.epoch) + 1n) : prior.epoch;
        const [updated] = await tx.update(spsWorkspaceExecutionControl).set({ state, epoch,
          revision: sql`${spsWorkspaceExecutionControl.revision} + 1`, updatedByUserId: actorUserId, updatedAt: new Date() })
          .where(eq(spsWorkspaceExecutionControl.companyId, companyId)).returning();
        if (action === "stop") await persistStopIntent(tx, companyId, epoch);
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: actorUserId,
          action: `workspace.execution.${action}`, entityType: "company", entityId: companyId,
          details: { state, epoch, revision: updated.revision } });
        return snapshot(updated);
      });
      // State is durable before cancellation begins. A failed handler never reopens admission.
      // Handlers must select only epochs older than control.epoch: a concurrent resume
      // may admit new work while old cancellation is still waiting for acknowledgement.
      const failures: string[] = [];
      if (action === "stop") {
        let operations = stopping.get(db);
        if (!operations) { operations = new Map(); stopping.set(db, operations); }
        const joined = Promise.all([...stopHandlers.get(db)?.entries() ?? []].map(async ([lane, handler]) => {
          const key = `${companyId}:${control.epoch}:${lane}`;
          let operation = operations.get(key);
          if (!operation) {
            operation = Promise.resolve().then(() => handler(companyId, "Workspace execution was stopped.", control.epoch));
            operations.set(key, operation);
            void operation.finally(() => { if (operations?.get(key) === operation) operations.delete(key); }).catch(() => {});
          }
          try { await operation; } catch { failures.push(lane); }
        }));
        // A disconnected Node or unresponsive worker must not hang the control UI.
        // The same owned requests continue; pending counts remain authoritative.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([joined, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      return { ...control, pending: await getSpsWorkspaceExecutionPending(db, companyId), cancellationFailures: [...failures].sort() };
    },
  };
}
