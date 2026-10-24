import { createHash } from "node:crypto";
import type { PluginSpsUsageEvidence, PluginSpsUsageMetric } from "../compat/paperclip/plugin-sdk.js";
import { readSpsUsageEvidence, unavailableSpsUsage } from "./sps-execution-usage.js";

const RECEIPT_SCHEMA = "sps.execution-usage-receipt/v1" as const;
const RECEIPT_SOURCE = "adapter-completion" as const;
const MAX_RECEIPT_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLUGIN_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const BILLING_TYPES = new Set(["metered_api", "subscription_included", "subscription_overage", "credits", "fixed", "unknown"]);
const USAGE_KEYS = ["schemaVersion", "inputTokens", "cachedInputTokens", "outputTokens", "costUsd", "currency", "billingType", "costBasis"];
const METRIC_KEYS = ["value", "provenance"];

export interface SpsUsageReceiptScope {
  readonly companyId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly pluginKey: string;
  readonly sessionId: string;
}

export interface SpsExecutionUsageReceiptUsage {
  readonly schemaVersion: 1;
  readonly inputTokens: Readonly<PluginSpsUsageMetric>;
  readonly cachedInputTokens: Readonly<PluginSpsUsageMetric>;
  readonly outputTokens: Readonly<PluginSpsUsageMetric>;
  readonly costUsd: Readonly<PluginSpsUsageMetric>;
  readonly currency: "USD" | null;
  readonly billingType: PluginSpsUsageEvidence["billingType"];
  readonly costBasis: PluginSpsUsageEvidence["costBasis"];
}

export interface SpsExecutionUsageReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA;
  readonly source: typeof RECEIPT_SOURCE;
  readonly scope: SpsUsageReceiptScope;
  readonly usage: SpsExecutionUsageReceiptUsage;
  readonly digest: string;
}

export type SpsExecutionUsageReceiptRead = {
  state: "absent" | "invalid";
  usage: PluginSpsUsageEvidence | null;
} | {
  state: "valid";
  usage: PluginSpsUsageEvidence;
};

function fail(message: string): never {
  throw new TypeError(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? fail("Invalid canonical JSON value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(asciiCompare);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function parseScope(value: unknown, requireCanonical: boolean): SpsUsageReceiptScope {
  const keys = ["companyId", "runId", "agentId", "pluginKey", "sessionId"] as const;
  if (!hasExactKeys(value, keys)) return fail("Invalid receipt scope");
  const id = (key: "companyId" | "runId" | "agentId" | "sessionId") => {
    const id = value[key];
    if (typeof id !== "string" || !UUID.test(id)) return fail("Invalid receipt scope");
    if (requireCanonical && id !== id.toLowerCase()) return fail("Noncanonical receipt scope");
    return id.toLowerCase();
  };
  if (typeof value.pluginKey !== "string" || !PLUGIN_KEY.test(value.pluginKey)) return fail("Invalid receipt scope");
  return Object.freeze({
    companyId: id("companyId"),
    runId: id("runId"),
    agentId: id("agentId"),
    pluginKey: value.pluginKey,
    sessionId: id("sessionId"),
  });
}

function parseMetric(value: unknown, integer: boolean, cost = false): PluginSpsUsageMetric {
  if (!hasExactKeys(value, METRIC_KEYS)) return fail("Invalid usage metric");
  const metricValue = value.value;
  const provenance = value.provenance;
  if (provenance === "unavailable") {
    if (metricValue !== null) return fail("Invalid usage metric");
    return Object.freeze({ value: null, provenance: "unavailable" });
  }
  if (provenance !== "reported" && provenance !== "estimated") return fail("Invalid usage metric");
  if (cost && provenance !== "reported") return fail("Invalid cost provenance");
  if (typeof metricValue !== "number" || !Number.isFinite(metricValue) || metricValue < 0
    || metricValue > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(metricValue))) {
    return fail("Invalid usage metric value");
  }
  return Object.freeze({ value: metricValue === 0 ? 0 : metricValue, provenance });
}

function expectedCostBasis(billingType: PluginSpsUsageEvidence["billingType"]): PluginSpsUsageEvidence["costBasis"] {
  if (billingType === "metered_api" || billingType === "subscription_overage") return "incremental_api";
  if (billingType === "subscription_included") return "subscription_reference";
  return "unknown";
}

function parseUsage(value: unknown): { usage: SpsExecutionUsageReceiptUsage; evidence: PluginSpsUsageEvidence } {
  if (!hasExactKeys(value, USAGE_KEYS) || value.schemaVersion !== 1) return fail("Invalid usage evidence");
  const inputTokens = parseMetric(value.inputTokens, true);
  const cachedInputTokens = parseMetric(value.cachedInputTokens, true);
  const outputTokens = parseMetric(value.outputTokens, true);
  const costUsd = parseMetric(value.costUsd, false, true);
  if (value.currency !== "USD" && value.currency !== null) return fail("Invalid usage currency");
  if (typeof value.billingType !== "string" || !BILLING_TYPES.has(value.billingType)) return fail("Invalid billing type");
  const billingType = value.billingType as PluginSpsUsageEvidence["billingType"];
  const costBasis = expectedCostBasis(billingType);
  if (value.costBasis !== costBasis) return fail("Invalid usage cost basis");
  if ((costUsd.value === null) !== (value.currency === null)) return fail("Inconsistent usage cost currency");

  const evidence = readSpsUsageEvidence({ spsUsageEvidence: value });
  const usage = Object.freeze({
    schemaVersion: 1 as const,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
    currency: value.currency,
    billingType,
    costBasis,
  });
  return { usage, evidence };
}

function freezeReceipt(
  scope: SpsUsageReceiptScope,
  usage: SpsExecutionUsageReceiptUsage,
): SpsExecutionUsageReceipt {
  const payload = { schemaVersion: RECEIPT_SCHEMA, source: RECEIPT_SOURCE, scope, usage } as const;
  const digest = digestOf(payload);
  const receipt = Object.freeze({ ...payload, digest });
  if (Buffer.byteLength(canonicalJson(receipt), "utf8") > MAX_RECEIPT_BYTES) return fail("Usage receipt exceeds size limit");
  return receipt;
}

/** Creates bounded Core evidence of adapter completion, not a provider invoice. */
export function createSpsExecutionUsageReceipt(scope: SpsUsageReceiptScope, usageEvidence: unknown): SpsExecutionUsageReceipt {
  const canonicalScope = parseScope(scope, false);
  const { usage } = parseUsage(usageEvidence);
  return freezeReceipt(canonicalScope, usage);
}

function invalidRead(): SpsExecutionUsageReceiptRead {
  return { state: "invalid", usage: unavailableSpsUsage() };
}

/** Reads a receipt only when its digest and complete execution binding validate. */
export function readSpsExecutionUsageReceipt(usageJson: unknown, expectedScope: SpsUsageReceiptScope): SpsExecutionUsageReceiptRead {
  try {
    const canonicalExpected = parseScope(expectedScope, false);
    if (usageJson === null || typeof usageJson !== "object") return { state: "absent", usage: null };
    if (!isPlainRecord(usageJson)) return invalidRead();
    if (!Object.hasOwn(usageJson, "spsUsageReceipt")) return { state: "absent", usage: null };
    const receipt = usageJson.spsUsageReceipt;
    const receiptKeys = ["schemaVersion", "source", "scope", "usage", "digest"] as const;
    if (!hasExactKeys(receipt, receiptKeys)
      || receipt.schemaVersion !== RECEIPT_SCHEMA || receipt.source !== RECEIPT_SOURCE
      || typeof receipt.digest !== "string" || !/^[0-9a-f]{64}$/.test(receipt.digest)) return invalidRead();

    const scope = parseScope(receipt.scope, true);
    if (scope.companyId !== canonicalExpected.companyId || scope.runId !== canonicalExpected.runId
      || scope.agentId !== canonicalExpected.agentId || scope.pluginKey !== canonicalExpected.pluginKey
      || scope.sessionId !== canonicalExpected.sessionId) return invalidRead();

    const { usage, evidence } = parseUsage(receipt.usage);
    const payload = { schemaVersion: receipt.schemaVersion, source: receipt.source, scope, usage };
    if (digestOf(payload) !== receipt.digest) return invalidRead();
    if (Buffer.byteLength(canonicalJson({ ...payload, digest: receipt.digest }), "utf8") > MAX_RECEIPT_BYTES) return invalidRead();
    return { state: "valid", usage: evidence };
  } catch {
    return invalidRead();
  }
}
