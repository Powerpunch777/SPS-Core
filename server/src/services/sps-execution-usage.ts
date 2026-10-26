import type { PluginSpsUsageEvidence, PluginSpsUsageMetric } from "../compat/paperclip/plugin-sdk.js";

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
  usage?: unknown; normalizedUsage?: unknown; usageBasis?: unknown; usageReportedFields?: unknown;
  derivedFromSessionTotals?: boolean; costUsd?: unknown; costUsdBasis?: unknown; billingType?: unknown;
}) {
  const raw = record(input.usage), normalized = record(input.normalizedUsage);
  const provenance = input.usageBasis === "per_run" ? "reported"
    : input.usageBasis === "session_cumulative" || input.derivedFromSessionTotals ? "estimated" : "unavailable";
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens"];
  const suppliedFields = input.usageReportedFields;
  const validFields = Array.isArray(suppliedFields) && suppliedFields.every(key => typeof key === "string" && fields.includes(key))
    && new Set(suppliedFields).size === suppliedFields.length;
  const wasReported = (key: string) => suppliedFields === undefined || validFields && suppliedFields.includes(key);
  const tokens = (key: string) => metric(!wasReported(key) || number(raw[key], true) === null ? null : provenance === "reported" ? raw[key] : normalized[key], provenance);
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
