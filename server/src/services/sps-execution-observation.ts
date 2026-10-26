import type { PluginSpsExecution } from "../compat/paperclip/plugin-sdk.js";
import { readSpsUsageEvidence, unavailableSpsUsage } from "./sps-execution-usage.js";
import { readSpsExecutionUsageReceipt } from "./sps-execution-usage-receipt.js";
import { spsAgentUsageReceiptScope } from "./sps-execution-usage-context.js";
import { readSpsNodeUsage } from "./sps-node-usage.js";
export { buildSpsUsageEvidence, readSpsUsageEvidence, unavailableSpsUsage } from "./sps-execution-usage.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function safeLabel(value: unknown) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:/@+-]{0,119}$/i.test(value)
    && !/^[a-z]:[\\/]|^https?:|\.\.|[^@]+@[^@]+\.[^@]+|^(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|eyJ)/i.test(value)
    && value !== "unknown" ? value : null;
}
function elapsed(start: Date | null, end: Date | null, now: number, status: string) {
  if (!start || (!end && !["running", "claimed", "cancelling"].includes(status))) return null;
  const value = (end?.getTime() ?? now) - start.getTime();
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function phase(status: string, pending: boolean): PluginSpsExecution["phase"] {
  if (pending) return "stopping";
  if (status === "queued") return "queued";
  if (status === "running" || status === "claimed") return "active";
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(status)) return status as PluginSpsExecution["phase"];
  return status === "timed_out" ? "failed" : "unknown";
}
const failures = {
  auth_required: "authorization", permission_denied: "authorization", responsible_user_access_denied: "authorization", host_restored: "execution",
  configuration_incomplete: "configuration", workspace_validation_failed: "configuration", agent_not_invokable: "configuration",
  provider_quota: "provider_limit", timeout: "timeout", cancelled: "cancelled", adapter_failed: "execution", setup_failed: "execution", process_lost: "execution",
  permission_revoked: "authorization", dispatch_denied: "authorization", credential_unavailable: "authorization", timed_out: "timeout", lease_lost: "execution",
  network_error: "execution", http_error: "execution", invalid_response: "execution", response_too_large: "execution", credential_echo: "execution", busy: "configuration",
  provider_limit: "provider_limit", provider_error: "execution", invalid_request: "configuration", invalid_configuration: "configuration",
} as const;
function failure(status: string, code: string | null, timedOut = false): PluginSpsExecution["failure"] {
  if (!["failed", "timed_out", "cancelled", "interrupted"].includes(status)) return null;
  const known = code && Object.hasOwn(failures, code) ? code as keyof typeof failures : null;
  return { category: timedOut || status === "timed_out" ? "timeout" : status === "cancelled" ? "cancelled" : known ? failures[known] : status === "failed" ? "execution" : "unknown",
    code: known, retrySafety: "requires_review" };
}

type Common = { id: string; companyId: string; status: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null };
export type ObservedAgentRun = Common & { agentId: string; contextSnapshot: Record<string, unknown> | null; usageJson: Record<string, unknown> | null; errorCode: string | null };
export type ObservedNodeRun = Common & { pluginKey: string; subjectKey: string; command: string; timedOut: number;
  nodeId?: string; runnerProfileId?: string; executionGrantId?: string; usageJson?: unknown };
export type ObservedModelRun = Common & { pluginKey: string; model: string; cancellationRequestedAt: Date | null;
  externalEffects: string; errorCode: string | null; usageJson: Record<string, unknown> | null; resourcePending: boolean; leaseExpiresAt: Date | null };

/** Model identity is Host-configured, not a provider-reported resolved model. No prompt/output is loaded. */
export function observeSpsModelRun(run: ObservedModelRun, now = Date.now()): PluginSpsExecution {
  const stale = run.resourcePending && (!run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= now) && ["queued", "running"].includes(run.status);
  const status = stale ? "interrupted" : run.status, model = safeLabel(run.model), requested = run.cancellationRequestedAt !== null;
  const pending = requested && ["queued", "running"].includes(status);
  return { lane: "model_request", runId: run.id, companyId: run.companyId, pluginKey: run.pluginKey, agentId: null, sessionId: null, subjectKey: null,
    runtime: { kind: "model_api", model, modelSource: model ? "configured" : "unavailable" }, status, phase: phase(status, pending),
    cancellationRequested: requested, termination: requested && run.externalEffects === "unknown" ? "pending" : "not_applicable",
    failure: failure(status, stale ? "process_lost" : run.errorCode), createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null, elapsedMs: elapsed(run.startedAt, run.finishedAt, now, status), usage: readSpsUsageEvidence(run.usageJson) };
}

export function observeSpsAgentRun(run: ObservedAgentRun, pluginKey: string, now = Date.now()): PluginSpsExecution {
  const context = record(run.contextSnapshot), conversation = record(context.spsPluginConversation), runtime = record(context.spsExecutionRuntime);
  const requested = context.spsSessionCancellationRequested === true;
  const termination = !requested ? "not_applicable" : context.spsSessionCancellationTermination === "confirmed" ? "confirmed" : "pending";
  const model = safeLabel(record(run.usageJson).model);
  const scope = spsAgentUsageReceiptScope(run, pluginKey);
  const hasReceipt = Object.hasOwn(record(run.usageJson), "spsUsageReceipt");
  const receipt = scope ? readSpsExecutionUsageReceipt(run.usageJson, scope) : null;
  const usage = hasReceipt
    ? receipt?.state === "valid" && receipt.usage ? receipt.usage : unavailableSpsUsage()
    : readSpsUsageEvidence(run.usageJson);
  return { lane: "agent_session", runId: run.id, companyId: run.companyId, pluginKey, agentId: run.agentId,
    sessionId: typeof conversation.sessionId === "string" ? conversation.sessionId : null, subjectKey: null,
    runtime: { kind: safeLabel(runtime.adapterType), model, modelSource: model ? "reported" : "unavailable" },
    status: run.status, phase: phase(run.status, termination === "pending"), cancellationRequested: requested, termination,
    failure: failure(run.status, run.errorCode), createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null, elapsedMs: elapsed(run.startedAt, run.finishedAt, now, run.status), usage };
}
const runtimeByCommand: Record<string, string> = { codex: "codex_cli", claude: "claude_cli", agy: "agy_cli", gemini: "gemini_cli", opencode: "opencode_cli", pi: "pi_cli", ollama: "ollama", lms: "lm_studio" };
export function observeSpsNodeRun(run: ObservedNodeRun, now = Date.now()): PluginSpsExecution {
  const requested = run.status === "cancelling" || run.status === "cancelled";
  const usage = run.nodeId && run.runnerProfileId && run.executionGrantId && ["succeeded", "failed", "cancelled"].includes(run.status)
    ? readSpsNodeUsage({ ...run, nodeId: run.nodeId, runnerProfileId: run.runnerProfileId, executionGrantId: run.executionGrantId })
    : unavailableSpsUsage();
  return { lane: "node", runId: run.id, companyId: run.companyId, pluginKey: run.pluginKey, agentId: null, sessionId: null, subjectKey: run.subjectKey,
    runtime: { kind: Object.hasOwn(runtimeByCommand, run.command) ? runtimeByCommand[run.command] : null, model: null, modelSource: "unavailable" },
    status: run.status, phase: phase(run.status, run.status === "cancelling"), cancellationRequested: requested,
    termination: requested ? run.status === "cancelled" ? "confirmed" : "pending" : "not_applicable",
    failure: failure(run.status, null, run.timedOut !== 0), createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null, elapsedMs: elapsed(run.startedAt, run.finishedAt, now, run.status), usage };
}
