import { and, eq, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, spsNodeCommands, type Db } from "../compat/paperclip/db.js";
import type { AgentSessionRunState } from "../compat/paperclip/plugin-sdk.js";
import { notFound } from "../errors.js";
import { observeSpsAgentRun } from "./sps-execution-observation.js";
import { lockSpsWorkspaceExecutionControl } from "./sps-workspace-execution-control.js";
import { hasSpsNodeClosureEvidence } from "./sps-node-closure-evidence.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted", "timed_out"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Scope = { companyId: string; sessionId: string; runId: string };
type Run = typeof heartbeatRuns.$inferSelect;
const cancellationOperations = new WeakMap<Db, Map<string, Promise<AgentSessionRunState>>>();

export function hasSpsSessionCancellation(run: { contextSnapshot: unknown } | null) {
  return (run?.contextSnapshot as Record<string, unknown> | null)?.spsSessionCancellationRequested === true;
}

function pidHasExited(pid: number | null, groupId: number | null) {
  if (process.platform !== "win32" && groupId && Number.isInteger(groupId) && groupId > 0) {
    try { process.kill(-groupId, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  }
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function preserveSpsSessionCancellationContext(context: Record<string, unknown> | null) {
  // Adapter setup carries an older snapshot. It must not erase a concurrent
  // control-plane cancellation or overwrite its termination acknowledgement.
  return sql`(${JSON.stringify(context ?? {})}::jsonb) || case when ${heartbeatRuns.contextSnapshot} ? 'spsNodeCompletionReceipts' then jsonb_build_object('spsNodeCompletionReceipts', ${heartbeatRuns.contextSnapshot}->'spsNodeCompletionReceipts') else '{}'::jsonb end || case when ${heartbeatRuns.contextSnapshot}->>'spsSessionCancellationRequested' = 'true' then jsonb_build_object(
    'spsSessionCancellationRequested', true,
    'spsSessionCancellationTermination', ${heartbeatRuns.contextSnapshot}->'spsSessionCancellationTermination',
    'spsSessionCancellationWasQueued', ${heartbeatRuns.contextSnapshot}->'spsSessionCancellationWasQueued'
  ) else '{}'::jsonb end`;
}

export function spsAgentSessionRunService(db: Db, pluginKey: string, cancelRun: (runId: string) => Promise<unknown>) {
  async function owned(input: Scope) {
    if (![input.companyId, input.sessionId, input.runId].every(value => typeof value === "string" && uuid.test(value))) throw notFound("Session run not found");
    const session = await db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.id, input.sessionId), eq(agentTaskSessions.companyId, input.companyId),
    )).then(rows => rows[0]);
    if (!session?.taskKey.startsWith(`plugin:${pluginKey}:session:`)) throw notFound("Session run not found");
    const run = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, session.agentId),
    )).then(rows => rows[0]);
    const context = run?.contextSnapshot as Record<string, unknown> | null;
    const conversation = context?.spsPluginConversation as Record<string, unknown> | undefined;
    if (!run || context?.taskKey !== session.taskKey || conversation?.pluginKey !== pluginKey || conversation?.sessionId !== session.id) throw notFound("Session run not found");
    return run;
  }
  function snapshot(run: Run): AgentSessionRunState {
    const requested = hasSpsSessionCancellation(run);
    const evidence = run.contextSnapshot?.spsSessionCancellationTermination;
    return { runId: run.id, status: run.status, cancellationRequested: requested,
      termination: requested ? evidence === "confirmed" ? "confirmed" : "pending" : "not_applicable",
      errorCode: run.errorCode, error: run.error, execution: observeSpsAgentRun(run, pluginKey) };
  }
  async function getRun(input: Scope) {
    const run = await owned(input);
    if (hasSpsSessionCancellation(run) && terminal.has(run.status)) {
      const commands = await db.select().from(spsNodeCommands).where(and(
        eq(spsNodeCommands.companyId, input.companyId), eq(spsNodeCommands.heartbeatRunId, run.id),
      ));
      const receipts = run.contextSnapshot?.spsNodeCompletionReceipts as Record<string, unknown> | undefined;
      if (commands.some(command => !hasSpsNodeClosureEvidence(command, receipts?.[command.id] === true))) {
        // Older terminal policy decisions may carry an optimistic parent flag.
        // Expose current remote evidence without rewriting that audit history.
        return snapshot({ ...run, contextSnapshot: { ...run.contextSnapshot, spsSessionCancellationTermination: "pending" } });
      }
      const localProcessKnownExited = pidHasExited(run.processPid, run.processGroupId);
      const noLocalProcessRecorded = !run.processPid && !run.processGroupId;
      if (!noLocalProcessRecorded && !localProcessKnownExited) {
        return snapshot({ ...run, contextSnapshot: { ...run.contextSnapshot, spsSessionCancellationTermination: "pending" } });
      }
      if (run.contextSnapshot?.spsSessionCancellationTermination === "confirmed") return snapshot(run);
      if ((commands.length > 0 ? noLocalProcessRecorded || localProcessKnownExited : localProcessKnownExited)
        && commands.every(command => hasSpsNodeClosureEvidence(command, receipts?.[command.id] === true))) {
        await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || '{"spsSessionCancellationTermination":"confirmed"}'::jsonb` }).where(eq(heartbeatRuns.id, run.id));
        return snapshot(await owned(input));
      }
    }
    return snapshot(run);
  }
  async function cancelInternal(input: Scope) {
    const original = await owned(input);
    if (terminal.has(original.status)) return getRun(input);
    // Serialize the cancellation marker with remote dispatch. Neither a queued
    // command nor a late adapter may start after this durable request.
    await db.transaction(async tx => {
      await lockSpsWorkspaceExecutionControl(tx, input.companyId);
      const run = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original.id)).for("update").then(rows => rows[0]!);
      if (terminal.has(run.status) || hasSpsSessionCancellation(run)) return false;
      await tx.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending", spsSessionCancellationWasQueued: run.status === "queued" } }).where(eq(heartbeatRuns.id, run.id));
      await tx.update(spsNodeCommands).set({ status: "failed", error: "Session run cancelled before dispatch", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(spsNodeCommands.companyId, input.companyId), eq(spsNodeCommands.heartbeatRunId, run.id), eq(spsNodeCommands.status, "queued")));
      return true;
    });
    const current = await owned(input);
    if (!hasSpsSessionCancellation(current)) return snapshot(current);
    const commands = await db.select().from(spsNodeCommands).where(and(
      eq(spsNodeCommands.companyId, input.companyId), eq(spsNodeCommands.heartbeatRunId, current.id),
    ));
    // Remote cancellation completes only when a signed Node completion arrives.
    const receipts = current.contextSnapshot?.spsNodeCompletionReceipts as Record<string, unknown> | undefined;
    if (commands.some(command => !hasSpsNodeClosureEvidence(command, receipts?.[command.id] === true))) return snapshot(current);
    await cancelRun(current.id);
    if (current.contextSnapshot?.spsSessionCancellationWasQueued === true || pidHasExited(original.processPid, original.processGroupId)
      || (commands.length > 0 && commands.every(command => hasSpsNodeClosureEvidence(command, receipts?.[command.id] === true)))) {
      await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || '{"spsSessionCancellationTermination":"confirmed"}'::jsonb` }).where(eq(heartbeatRuns.id, current.id));
    }
    return getRun(input);
  }
  async function cancel(input: Scope) {
    await owned(input);
    let operations = cancellationOperations.get(db);
    if (!operations) { operations = new Map(); cancellationOperations.set(db, operations); }
    const pending = operations.get(input.runId);
    if (pending) return pending;
    const operation = cancelInternal(input);
    operations.set(input.runId, operation);
    try { return await operation; }
    finally { if (operations.get(input.runId) === operation) operations.delete(input.runId); }
  }
  return { getRun, cancel };
}
