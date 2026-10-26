import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSpsNodeUsageReceipt, readSpsNodeUsage } from "../services/sps-node-usage.js";
import { observeSpsNodeRun } from "../services/sps-execution-observation.js";
import { unavailableSpsUsage } from "../services/sps-execution-usage.js";

const run = { id: randomUUID(), companyId: randomUUID(), nodeId: randomUUID(), runnerProfileId: randomUUID(),
  executionGrantId: randomUUID(), pluginKey: "sps.usage-test", command: "claude", subjectKey: "subject", status: "succeeded",
  timedOut: 0, createdAt: new Date(0), startedAt: new Date(1), finishedAt: new Date(2) };
const report = { schemaVersion: 1, source: "claude_model_usage_v1", inputTokens: 0, cachedInputTokens: null, outputTokens: 4 };

describe("SPS signed Node completion usage projection", () => {
  it("preserves zero, unknown fields and unknown costs without inventing model or Agent identity", () => {
    const usageJson = createSpsNodeUsageReceipt(run, report);
    expect(observeSpsNodeRun({ ...run, usageJson })).toMatchObject({ agentId: null, runtime: { model: null }, usage: {
      inputTokens: { value: 0, provenance: "reported" }, cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: 4, provenance: "reported" }, costUsd: { value: null, provenance: "unavailable" }, billingType: "unknown",
    } });
    expect(createSpsNodeUsageReceipt(run, Object.fromEntries(Object.entries(report).reverse()))).toEqual(usageJson);
  });

  it("rejects reports for another runtime and all altered execution bindings", () => {
    const usageJson = createSpsNodeUsageReceipt(run, report);
    expect(() => createSpsNodeUsageReceipt({ ...run, command: "codex" }, report)).toThrow();
    for (const key of ["id", "companyId", "nodeId", "runnerProfileId", "executionGrantId", "pluginKey"] as const) {
      const changed = { ...run, [key]: key === "pluginKey" ? "sps.other" : randomUUID(), usageJson };
      expect(readSpsNodeUsage(changed)).toEqual(unavailableSpsUsage());
    }
  });

  it("rejects malformed receipts and unsealed evidence without throwing in history", () => {
    const receipt = createSpsNodeUsageReceipt(run, report).spsNodeUsageReceipt;
    for (const invalid of [null, {}, { ...receipt, digest: "0".repeat(64) }, { ...receipt, extra: "secret" },
      { ...receipt, scope: { ...receipt.scope, extra: true } }, { ...receipt, report: { ...report, outputTokens: 999 } },
      { ...receipt, report: { ...report, prompt: "secret" } }]) {
      expect(readSpsNodeUsage({ ...run, usageJson: { spsNodeUsageReceipt: invalid, spsUsageEvidence: report } })).toEqual(unavailableSpsUsage());
    }
    expect(readSpsNodeUsage(run)).toEqual(unavailableSpsUsage());
    expect(observeSpsNodeRun({ ...run, status: "running", usageJson: createSpsNodeUsageReceipt(run, report) }).usage).toEqual(unavailableSpsUsage());
  });
});
