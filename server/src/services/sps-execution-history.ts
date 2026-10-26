import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, spsModelConnections, spsModelRuns, spsPluginNodeRuns, type Db } from "../compat/paperclip/db.js";
import type { PluginSpsExecution, PluginSpsExecutionCursor, PluginSpsExecutionLane, PluginSpsExecutionPage, PluginSpsExecutionSummaryOptions } from "../compat/paperclip/plugin-sdk.js";
import { observeSpsAgentRun, observeSpsModelRun, observeSpsNodeRun } from "./sps-execution-observation.js";
import { SPS_EXECUTION_SUMMARY_MAX_RUNS, summarizeSpsExecutions, validateSpsExecutionSummaryOptions } from "./sps-execution-summary.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const laneValid = (value: unknown): value is PluginSpsExecutionLane => value === "node" || value === "agent_session" || value === "model_request";
function requireUuid(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("Execution identifiers must be UUIDs");
  return value.toLowerCase();
}
function cursorValue(value: unknown): PluginSpsExecutionCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution cursor");
  const cursor = value as Record<string, unknown>;
  if (Object.keys(cursor).sort().join(",") !== "createdAt,lane,runId" || !laneValid(cursor.lane)
    || typeof cursor.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.createdAt)
    || !Number.isFinite(Date.parse(cursor.createdAt)) || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error("Invalid execution cursor");
  return { createdAt: cursor.createdAt, lane: cursor.lane, runId: requireUuid(cursor.runId) };
}
// PostgreSQL retains microseconds, but the public cursor uses JS millisecond
// timestamps. Both ordering and filtering must use that same precision.
function before(time: SQL, id: SQL, lane: PluginSpsExecutionLane, cursor?: PluginSpsExecutionCursor) {
  if (!cursor) return undefined;
  return sql`(${time} < ${cursor.createdAt}::timestamptz or (${time} = ${cursor.createdAt}::timestamptz and (${id} < ${cursor.runId}::uuid or (${id} = ${cursor.runId}::uuid and ${lane}::text < ${cursor.lane}::text))))`;
}
const agentColumns = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
  createdAt: heartbeatRuns.createdAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, errorCode: heartbeatRuns.errorCode,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
    'taskKey', ${heartbeatRuns.contextSnapshot}->'taskKey',
    'spsPluginConversation', jsonb_build_object('sessionId', ${heartbeatRuns.contextSnapshot}->'spsPluginConversation'->'sessionId',
      'pluginKey', ${heartbeatRuns.contextSnapshot}->'spsPluginConversation'->'pluginKey'),
    'spsExecutionRuntime', jsonb_build_object('adapterType', ${heartbeatRuns.contextSnapshot}->'spsExecutionRuntime'->'adapterType'),
    'spsSessionCancellationRequested', ${heartbeatRuns.contextSnapshot}->'spsSessionCancellationRequested',
    'spsSessionCancellationTermination', ${heartbeatRuns.contextSnapshot}->'spsSessionCancellationTermination')`,
  usageJson: sql<Record<string, unknown>>`jsonb_build_object('model', ${heartbeatRuns.usageJson}->'model', 'spsUsageEvidence', ${heartbeatRuns.usageJson}->'spsUsageEvidence')
    || case when ${heartbeatRuns.usageJson} ? 'spsUsageReceipt' then jsonb_build_object('spsUsageReceipt', ${heartbeatRuns.usageJson}->'spsUsageReceipt') else '{}'::jsonb end`,
};
const nodeColumns = {
  id: spsPluginNodeRuns.id, companyId: spsPluginNodeRuns.companyId, pluginKey: spsPluginNodeRuns.pluginKey,
  subjectKey: spsPluginNodeRuns.subjectKey, status: spsPluginNodeRuns.status, command: spsPluginNodeRuns.command,
  nodeId: spsPluginNodeRuns.nodeId, runnerProfileId: spsPluginNodeRuns.runnerProfileId, executionGrantId: spsPluginNodeRuns.executionGrantId,
  usageJson: spsPluginNodeRuns.usageJson,
  timedOut: spsPluginNodeRuns.timedOut, createdAt: spsPluginNodeRuns.createdAt, startedAt: spsPluginNodeRuns.startedAt, finishedAt: spsPluginNodeRuns.finishedAt,
};
const modelColumns = {
  id: spsModelRuns.id, companyId: spsModelRuns.companyId, pluginKey: spsModelRuns.pluginKey, status: spsModelRuns.status,
  model: spsModelConnections.model, cancellationRequestedAt: spsModelRuns.cancellationRequestedAt, externalEffects: spsModelRuns.externalEffects,
  errorCode: spsModelRuns.errorCode, usageJson: spsModelRuns.usageJson, resourcePending: spsModelRuns.resourcePending, leaseExpiresAt: spsModelRuns.leaseExpiresAt,
  createdAt: spsModelRuns.createdAt, startedAt: spsModelRuns.startedAt, finishedAt: spsModelRuns.finishedAt,
};

/** Own-plugin technical history. No mutable session join, raw output or billing writes. */
export function spsExecutionHistoryService(db: Db, pluginKey: string) {
  const agentTime = sql`date_trunc('milliseconds', ${heartbeatRuns.createdAt})`;
  const nodeTime = sql`date_trunc('milliseconds', ${spsPluginNodeRuns.createdAt})`;
  const modelTime = sql`date_trunc('milliseconds', ${spsModelRuns.createdAt})`;
  const modelJoin = and(eq(spsModelConnections.id, spsModelRuns.connectionId), eq(spsModelConnections.companyId, spsModelRuns.companyId));
  function agentScope(companyId: string) {
    return and(eq(heartbeatRuns.companyId, companyId),
      sql`${heartbeatRuns.contextSnapshot}->'spsPluginConversation'->>'pluginKey' = ${pluginKey}`,
      sql`starts_with(${heartbeatRuns.contextSnapshot}->>'taskKey', ${`plugin:${pluginKey}:session:`})`,
      sql`${heartbeatRuns.contextSnapshot}->'spsPluginConversation'->>'sessionId' ~* ${uuid.source}`);
  }
  async function list(companyId: string, options: { lane?: PluginSpsExecutionLane; limit?: number; before?: PluginSpsExecutionCursor } = {}): Promise<PluginSpsExecutionPage> {
    companyId = requireUuid(companyId);
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid execution options");
    if (options.lane !== undefined && !laneValid(options.lane)) throw new Error("Invalid execution lane");
    const limit = options.limit === undefined ? 50 : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Execution limit must be an integer from 1 to 100");
    const cursor = cursorValue(options.before), now = Date.now();
    const items: PluginSpsExecution[] = [];
    if (!options.lane || options.lane === "agent_session") {
      const rows = await db.select(agentColumns).from(heartbeatRuns).where(and(agentScope(companyId), before(agentTime, sql`${heartbeatRuns.id}`, "agent_session", cursor)))
        .orderBy(desc(agentTime), desc(heartbeatRuns.id)).limit(limit + 1);
      items.push(...rows.map(run => observeSpsAgentRun(run, pluginKey, now)));
    }
    if (!options.lane || options.lane === "node") {
      const rows = await db.select(nodeColumns).from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.companyId, companyId), eq(spsPluginNodeRuns.pluginKey, pluginKey), before(nodeTime, sql`${spsPluginNodeRuns.id}`, "node", cursor)))
        .orderBy(desc(nodeTime), desc(spsPluginNodeRuns.id)).limit(limit + 1);
      items.push(...rows.map(run => observeSpsNodeRun(run, now)));
    }
    if (!options.lane || options.lane === "model_request") {
      const rows = await db.select(modelColumns).from(spsModelRuns).innerJoin(spsModelConnections, modelJoin)
        .where(and(eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.pluginKey, pluginKey), before(modelTime, sql`${spsModelRuns.id}`, "model_request", cursor)))
        .orderBy(desc(modelTime), desc(spsModelRuns.id)).limit(limit + 1);
      items.push(...rows.map(run => observeSpsModelRun(run, now)));
    }
    items.sort((a, b) => {
      for (const key of ["createdAt", "runId", "lane"] as const) { if (a[key] !== b[key]) return a[key] > b[key] ? -1 : 1; }
      return 0;
    });
    const page = items.slice(0, limit), last = page.at(-1);
    return { items: page, nextCursor: items.length > limit && last ? { createdAt: last.createdAt, runId: last.runId, lane: last.lane } : null };
  }
  async function get(companyId: string, lane: PluginSpsExecutionLane, runId: string): Promise<PluginSpsExecution | null> {
    companyId = requireUuid(companyId); runId = requireUuid(runId);
    if (!laneValid(lane)) throw new Error("Invalid execution lane");
    if (lane === "agent_session") {
      const [run] = await db.select(agentColumns).from(heartbeatRuns).where(and(agentScope(companyId), eq(heartbeatRuns.id, runId))).limit(1);
      return run ? observeSpsAgentRun(run, pluginKey) : null;
    }
    if (lane === "model_request") {
      const [run] = await db.select(modelColumns).from(spsModelRuns).innerJoin(spsModelConnections, modelJoin)
        .where(and(eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.pluginKey, pluginKey), eq(spsModelRuns.id, runId))).limit(1);
      return run ? observeSpsModelRun(run) : null;
    }
    const [run] = await db.select(nodeColumns).from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.companyId, companyId), eq(spsPluginNodeRuns.pluginKey, pluginKey), eq(spsPluginNodeRuns.id, runId))).limit(1);
    return run ? observeSpsNodeRun(run) : null;
  }
  async function summarize(companyId: string, input: PluginSpsExecutionSummaryOptions) {
    companyId = requireUuid(companyId);
    const options = validateSpsExecutionSummaryOptions(input);
    const from = new Date(options.from), to = new Date(options.to), now = Date.now();
    // All lanes must come from one DB snapshot; never silently aggregate a
    // truncated page or mutate the legacy cost ledger on a read.
    return db.transaction(async tx => {
      const items: PluginSpsExecution[] = [];
      if (!options.lane || options.lane === "agent_session") {
        const rows = await tx.select(agentColumns).from(heartbeatRuns).where(and(agentScope(companyId), gte(heartbeatRuns.createdAt, from), lt(heartbeatRuns.createdAt, to),
          options.agentId ? eq(heartbeatRuns.agentId, options.agentId) : undefined)).limit(SPS_EXECUTION_SUMMARY_MAX_RUNS + 1);
        items.push(...rows.map(run => observeSpsAgentRun(run, pluginKey, now)));
      }
      if ((!options.lane || options.lane === "node") && !options.agentId) {
        const rows = await tx.select(nodeColumns).from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.companyId, companyId), eq(spsPluginNodeRuns.pluginKey, pluginKey),
          gte(spsPluginNodeRuns.createdAt, from), lt(spsPluginNodeRuns.createdAt, to))).limit(SPS_EXECUTION_SUMMARY_MAX_RUNS + 1);
        items.push(...rows.map(run => observeSpsNodeRun(run, now)));
      }
      if ((!options.lane || options.lane === "model_request") && !options.agentId) {
        const rows = await tx.select(modelColumns).from(spsModelRuns).innerJoin(spsModelConnections, modelJoin)
          .where(and(eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.pluginKey, pluginKey), gte(spsModelRuns.createdAt, from), lt(spsModelRuns.createdAt, to)))
          .limit(SPS_EXECUTION_SUMMARY_MAX_RUNS + 1);
        items.push(...rows.map(run => observeSpsModelRun(run, now)));
      }
      return summarizeSpsExecutions(companyId, pluginKey, options, items, now);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  return { list, get, summarize };
}
