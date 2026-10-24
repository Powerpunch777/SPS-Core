import { createHash } from "node:crypto";
import { z } from "zod";
import { spsNodeUsageReportSchema } from "../compat/paperclip/shared.js";
import { buildSpsUsageEvidence, readSpsUsageEvidence, unavailableSpsUsage } from "./sps-execution-usage.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const scopeSchema = z.object({
  companyId: uuid, runId: uuid, nodeId: uuid, runnerProfileId: uuid, executionGrantId: uuid,
  pluginKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/i),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal("sps.node-usage-receipt/v1"),
  scope: scopeSchema,
  report: spsNodeUsageReportSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

type NodeUsageRun = {
  id: string; companyId: string; nodeId: string; runnerProfileId: string;
  executionGrantId: string; pluginKey: string; command: string;
};

function scopeFor(run: NodeUsageRun) {
  if (run.command !== "claude") throw new Error("Usage report does not match the execution runtime");
  return scopeSchema.parse({ companyId: run.companyId.toLowerCase(), runId: run.id.toLowerCase(),
    nodeId: run.nodeId.toLowerCase(), runnerProfileId: run.runnerProfileId.toLowerCase(),
    executionGrantId: run.executionGrantId.toLowerCase(), pluginKey: run.pluginKey });
}

// Zod constructs each strict object in schema order; no caller-selected keys or
// free-form text enter this digest. This is Node report integrity, not an invoice.
function digest(payload: Omit<z.infer<typeof receiptSchema>, "digest">) {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function createSpsNodeUsageReceipt(run: NodeUsageRun, input: unknown) {
  const payload = { schemaVersion: "sps.node-usage-receipt/v1" as const,
    scope: scopeFor(run), report: spsNodeUsageReportSchema.parse(input) };
  return { spsNodeUsageReceipt: { ...payload, digest: digest(payload) } };
}

export function readSpsNodeUsage(run: NodeUsageRun & { usageJson?: unknown }) {
  try {
    if (!run.usageJson || typeof run.usageJson !== "object" || Array.isArray(run.usageJson)) return unavailableSpsUsage();
    const receipt = receiptSchema.parse((run.usageJson as Record<string, unknown>).spsNodeUsageReceipt);
    const expected = scopeFor(run);
    if (JSON.stringify(receipt.scope) !== JSON.stringify(expected)) return unavailableSpsUsage();
    const payload = { schemaVersion: receipt.schemaVersion, scope: receipt.scope, report: receipt.report };
    if (digest(payload) !== receipt.digest) return unavailableSpsUsage();
    return readSpsUsageEvidence({ spsUsageEvidence: buildSpsUsageEvidence({
      usage: receipt.report, usageBasis: "per_run",
      usageReportedFields: ["inputTokens", "cachedInputTokens", "outputTokens"],
    }) });
  } catch {
    return unavailableSpsUsage();
  }
}
