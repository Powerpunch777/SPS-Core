import type { PluginSpsExecution, PluginSpsExecutionSummary, PluginSpsExecutionSummaryOptions, PluginSpsUsageAggregateMetric, PluginSpsUsageMetric } from "../compat/paperclip/plugin-sdk.js";

export const SPS_EXECUTION_SUMMARY_MAX_RUNS = 10_000;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function validateSpsExecutionSummaryOptions(value: unknown): PluginSpsExecutionSummaryOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution summary options are required");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["from", "to", "lane", "agentId"].includes(key))) throw new Error("Unknown execution summary option");
  for (const key of ["from", "to"] as const) {
    if (typeof input[key] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input[key])
      || !Number.isFinite(Date.parse(input[key])) || new Date(input[key]).toISOString() !== input[key]) throw new Error("Summary from/to must use canonical UTC millisecond timestamps");
  }
  const duration = Date.parse(input.to as string) - Date.parse(input.from as string);
  if (duration <= 0 || duration > 31 * 24 * 60 * 60 * 1000) throw new Error("Execution summary window must be greater than zero and at most 31 days");
  if (input.lane !== undefined && input.lane !== "node" && input.lane !== "agent_session") throw new Error("Invalid execution summary lane");
  if (input.agentId !== undefined && (typeof input.agentId !== "string" || !uuid.test(input.agentId))) throw new Error("Execution summary agentId must be a UUID");
  if (input.agentId !== undefined && input.lane === "node") throw new Error("Node executions do not have an Agent identity");
  return { from: input.from as string, to: input.to as string,
    ...(input.lane === undefined ? {} : { lane: input.lane }), ...(input.agentId === undefined ? {} : { agentId: (input.agentId as string).toLowerCase() }) };
}
const emptyMetric = (): PluginSpsUsageAggregateMetric => ({ reported: null, estimated: null, reportedExecutions: 0, estimatedExecutions: 0, unavailableExecutions: 0, overflowed: false });
function addMetric(total: PluginSpsUsageAggregateMetric, metric: PluginSpsUsageMetric) {
  if (metric.value === null || metric.provenance === "unavailable") { total.unavailableExecutions++; return; }
  const key = metric.provenance;
  const countKey = key === "reported" ? "reportedExecutions" : "estimatedExecutions";
  const previousCount = total[countKey]++;
  if (previousCount > 0 && total[key] === null) return; // A previous overflow must stay unknown.
  const sum = (total[key] ?? 0) + metric.value;
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) { total[key] = null; total.overflowed = true; }
  else total[key] = sum;
}

/** Read projection, not a second billing ledger. Count each lane/run pair once. */
export function summarizeSpsExecutions(companyId: string, pluginKey: string, options: PluginSpsExecutionSummaryOptions, rows: PluginSpsExecution[], now = Date.now()): PluginSpsExecutionSummary {
  const window = validateSpsExecutionSummaryOptions(options);
  const summary: PluginSpsExecutionSummary = { companyId, pluginKey, window: { from: window.from, to: window.to }, generatedAt: new Date(now).toISOString(),
    executionCount: 0, terminalCount: 0, inFlightCount: 0, unknownPhaseCount: 0,
    tokens: { inputTokens: emptyMetric(), cachedInputTokens: emptyMetric(), outputTokens: emptyMetric() },
    costs: { currency: "USD", incrementalApi: emptyMetric(), subscriptionReference: emptyMetric(), other: emptyMetric() },
    duration: { totalMs: null, knownExecutions: 0, unavailableExecutions: 0, overflowed: false } };
  const seen = new Map<string, string>();
  for (const row of rows) {
    if (row.companyId !== companyId || row.pluginKey !== pluginKey || row.createdAt < window.from || row.createdAt >= window.to
      || window.lane && row.lane !== window.lane || window.agentId && row.agentId !== window.agentId) throw new Error("Execution summary scope mismatch");
    const key = `${row.lane}:${row.runId}`, identity = JSON.stringify(row);
    const prior = seen.get(key);
    if (prior !== undefined) { if (prior !== identity) throw new Error("Conflicting execution snapshots"); continue; }
    seen.set(key, identity);
    if (++summary.executionCount > SPS_EXECUTION_SUMMARY_MAX_RUNS) throw new Error("Execution summary exceeds 10000 executions; narrow the time window");
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(row.phase)) summary.terminalCount++;
    else if (["queued", "active", "stopping"].includes(row.phase)) summary.inFlightCount++;
    else summary.unknownPhaseCount++;
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) addMetric(summary.tokens[key], row.usage[key]);
    const costKey = row.usage.costBasis === "incremental_api" ? "incrementalApi" : row.usage.costBasis === "subscription_reference" ? "subscriptionReference" : "other";
    addMetric(summary.costs[costKey], row.usage.costUsd);
    if (row.elapsedMs === null) summary.duration.unavailableExecutions++;
    else {
      summary.duration.knownExecutions++;
      if (!summary.duration.overflowed) {
        const total = (summary.duration.totalMs ?? 0) + row.elapsedMs;
        if (!Number.isSafeInteger(total)) { summary.duration.totalMs = null; summary.duration.overflowed = true; }
        else summary.duration.totalMs = total;
      }
    }
  }
  return summary;
}
