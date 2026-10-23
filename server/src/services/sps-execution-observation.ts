import type { PluginSpsExecution, PluginSpsUsageEvidence, PluginSpsUsageMetric } from "../compat/paperclip/plugin-sdk.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const billingTypes = new Set(["metered_api", "subscription_included", "subscription_overage", "credits", "fixed"]);
function billingType(value: unknown): PluginSpsUsageEvidence["billingType"] {
  const normalized = value === "api" ? "metered_api" : value === "subscription" ? "subscription_included" : value;
  return typeof normalized === "string" && billingTypes.has(normalized) ? normalized as PluginSpsUsageEvidence["billingType"] : "unknown";
}
function number(value: unknown, integer: boolean) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER && (!integer || Number.isSafeInteger(value)) ? value : null;
}
function metric(value: unknown, provenance: PluginSpsUsageMetric["provenance"], integer = true): PluginSpsUsageMetric {
  const valid = provenance === "unavailable" ? null : number(value, integer);
  return { value: valid, provenance: valid === null ? "unavailable" : provenance };
}
export function unavailableSpsUsage(): PluginSpsUsageEvidence {
  return { inputTokens: metric(null, "unavailable"), cachedInputTokens: metric(null, "unavailable"), outputTokens: metric(null, "unavailable"),
    costUsd: metric(null, "unavailable", false), currency: null, billingType: "unknown", costBasis: "unknown" };
}

/** Adapter reports are not provider invoices. Preserve unknown fields as null. */
export function buildSpsUsageEvidence(input: {
  usage?: unknown; normalizedUsage?: unknown; usageBasis?: unknown;
  derivedFromSessionTotals?: boolean; costUsd?: unknown; costUsdBasis?: unknown; billingType?: unknown;
}) {
  const raw = record(input.usage), normalized = record(input.normalizedUsage);
  const provenance = input.usageBasis === "per_run" ? "reported"
    : input.usageBasis === "session_cumulative" || input.derivedFromSessionTotals ? "estimated" : "unavailable";
  const tokens = (key: string) => metric(number(raw[key], true) === null ? null : provenance === "reported" ? raw[key] : normalized[key], provenance);
  const billing = billingType(input.billingType);
  const cost = metric(input.costUsd, input.costUsdBasis === "per_run" ? "reported" : "unavailable", false);
  return { schemaVersion: 1, inputTokens: tokens("inputTokens"), cachedInputTokens: tokens("cachedInputTokens"), outputTokens: tokens("outputTokens"),
    costUsd: cost, currency: cost.value === null ? null : "USD" as const, billingType: billing,
    costBasis: billing === "metered_api" || billing === "subscription_overage" ? "incremental_api" as const
      : billing === "subscription_included" ? "subscription_reference" as const : "unknown" as const };
}

export function readSpsUsageEvidence(usageJson: unknown): PluginSpsUsageEvidence {
  const evidence = record(record(usageJson).spsUsageEvidence);
  if (evidence.schemaVersion !== 1) return unavailableSpsUsage();
  const readMetric = (value: unknown, integer = true) => {
    const parsed = record(value);
    return metric(parsed.value, parsed.provenance === "reported" || parsed.provenance === "estimated" ? parsed.provenance : "unavailable", integer);
  };
  const billing = billingType(evidence.billingType);
  const cost = evidence.currency === "USD" ? readMetric(evidence.costUsd, false) : metric(null, "unavailable", false);
  return { inputTokens: readMetric(evidence.inputTokens), cachedInputTokens: readMetric(evidence.cachedInputTokens), outputTokens: readMetric(evidence.outputTokens),
    costUsd: cost, currency: cost.value === null ? null : "USD", billingType: billing,
    costBasis: billing === "metered_api" || billing === "subscription_overage" ? "incremental_api" : billing === "subscription_included" ? "subscription_reference" : "unknown" };
}

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
  auth_required: "authorization", permission_denied: "authorization", responsible_user_access_denied: "authorization",
  configuration_incomplete: "configuration", workspace_validation_failed: "configuration", agent_not_invokable: "configuration",
  provider_quota: "provider_limit", timeout: "timeout", cancelled: "cancelled", adapter_failed: "execution", setup_failed: "execution", process_lost: "execution",
} as const;
function failure(status: string, code: string | null, timedOut = false): PluginSpsExecution["failure"] {
  if (!["failed", "timed_out", "cancelled", "interrupted"].includes(status)) return null;
  const known = code && Object.hasOwn(failures, code) ? code as keyof typeof failures : null;
  return { category: timedOut || status === "timed_out" ? "timeout" : status === "cancelled" ? "cancelled" : known ? failures[known] : status === "failed" ? "execution" : "unknown",
    code: known, retrySafety: "requires_review" };
}

type Common = { id: string; companyId: string; status: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null };
export type ObservedAgentRun = Common & { agentId: string; contextSnapshot: Record<string, unknown> | null; usageJson: Record<string, unknown> | null; errorCode: string | null };
export type ObservedNodeRun = Common & { pluginKey: string; subjectKey: string; command: string; timedOut: number };

export function observeSpsAgentRun(run: ObservedAgentRun, pluginKey: string, now = Date.now()): PluginSpsExecution {
  const context = record(run.contextSnapshot), conversation = record(context.spsPluginConversation), runtime = record(context.spsExecutionRuntime);
  const requested = context.spsSessionCancellationRequested === true;
  const termination = !requested ? "not_applicable" : context.spsSessionCancellationTermination === "confirmed" ? "confirmed" : "pending";
  const model = safeLabel(record(run.usageJson).model);
  return { lane: "agent_session", runId: run.id, companyId: run.companyId, pluginKey, agentId: run.agentId,
    sessionId: typeof conversation.sessionId === "string" ? conversation.sessionId : null, subjectKey: null,
    runtime: { kind: safeLabel(runtime.adapterType), model, modelSource: model ? "reported" : "unavailable" },
    status: run.status, phase: phase(run.status, termination === "pending"), cancellationRequested: requested, termination,
    failure: failure(run.status, run.errorCode), createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null, elapsedMs: elapsed(run.startedAt, run.finishedAt, now, run.status), usage: readSpsUsageEvidence(run.usageJson) };
}
const runtimeByCommand: Record<string, string> = { codex: "codex_cli", claude: "claude_cli", agy: "agy_cli", gemini: "gemini_cli", opencode: "opencode_cli", pi: "pi_cli", ollama: "ollama", lms: "lm_studio" };
export function observeSpsNodeRun(run: ObservedNodeRun, now = Date.now()): PluginSpsExecution {
  const requested = run.status === "cancelling" || run.status === "cancelled";
  return { lane: "node", runId: run.id, companyId: run.companyId, pluginKey: run.pluginKey, agentId: null, sessionId: null, subjectKey: run.subjectKey,
    runtime: { kind: Object.hasOwn(runtimeByCommand, run.command) ? runtimeByCommand[run.command] : null, model: null, modelSource: "unavailable" },
    status: run.status, phase: phase(run.status, run.status === "cancelling"), cancellationRequested: requested,
    termination: requested ? run.status === "cancelled" ? "confirmed" : "pending" : "not_applicable",
    failure: failure(run.status, null, run.timedOut !== 0), createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null, elapsedMs: elapsed(run.startedAt, run.finishedAt, now, run.status), usage: unavailableSpsUsage() };
}
