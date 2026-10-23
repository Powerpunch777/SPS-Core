import { describe, expect, it } from "vitest";
import { buildSpsUsageEvidence, readSpsUsageEvidence, observeSpsAgentRun, observeSpsNodeRun, unavailableSpsUsage } from "../services/sps-execution-observation.js";

const run = { id: "run", companyId: "workspace", agentId: "agent", status: "succeeded", createdAt: new Date(0), startedAt: new Date(10), finishedAt: new Date(100), contextSnapshot: null, usageJson: null, errorCode: null };
describe("workflow-neutral execution observation", () => {
  it("preserves reported zero and leaves missing cached tokens unavailable", () => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 0, outputTokens: 3 }, usageBasis: "per_run", costUsd: 0, costUsdBasis: "per_run", billingType: "api" });
    expect(readSpsUsageEvidence({ spsUsageEvidence: evidence })).toMatchObject({
      inputTokens: { value: 0, provenance: "reported" }, cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: 3, provenance: "reported" }, costUsd: { value: 0, provenance: "reported" }, currency: "USD", costBasis: "incremental_api",
    });
  });
  it("marks session deltas estimated and does not turn missing raw fields into normalized zero", () => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 100, outputTokens: 40 }, normalizedUsage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0 }, usageBasis: "session_cumulative", billingType: "subscription" });
    expect(evidence).toMatchObject({ inputTokens: { value: 10, provenance: "estimated" }, outputTokens: { value: 4, provenance: "estimated" }, cachedInputTokens: { value: null, provenance: "unavailable" }, costUsd: { value: null }, costBasis: "subscription_reference" });
    expect(buildSpsUsageEvidence({ usage: { inputTokens: 20 }, normalizedUsage: { inputTokens: 2 }, derivedFromSessionTotals: true }).inputTokens).toEqual({ value: 2, provenance: "estimated" });
  });
  it.each([null, -1, Infinity, NaN, 1.5, "12", Number.MAX_SAFE_INTEGER + 1])("rejects invalid token counts without fabricating zero (%s)", value => {
    expect(buildSpsUsageEvidence({ usage: { inputTokens: value }, usageBasis: "per_run" }).inputTokens).toEqual({ value: null, provenance: "unavailable" });
  });
  it("does not reinterpret legacy usage or unknown usage basis", () => {
    expect(readSpsUsageEvidence({ inputTokens: 0, costUsd: 0, billingType: "subscription" })).toEqual(unavailableSpsUsage());
    expect(buildSpsUsageEvidence({ usage: { inputTokens: 12 }, normalizedUsage: { inputTokens: 12 } }).inputTokens.value).toBeNull();
    expect(readSpsUsageEvidence({ spsUsageEvidence: { schemaVersion: 2 } })).toEqual(unavailableSpsUsage());
  });
  it("distinguishes subscription reference cost from incremental API cost", () => {
    expect(buildSpsUsageEvidence({ costUsd: 0.12, costUsdBasis: "per_run", billingType: "subscription_included" })).toMatchObject({ costUsd: { value: 0.12, provenance: "reported" }, costBasis: "subscription_reference" });
    for (const costUsdBasis of [undefined, "session_cumulative"]) {
      expect(buildSpsUsageEvidence({ costUsd: 20, costUsdBasis, usageBasis: "per_run" }).costUsd.value).toBeNull();
    }
    expect(buildSpsUsageEvidence({ billingType: "subscription_included" }).costUsd.value).toBeNull();
    expect(buildSpsUsageEvidence({ costUsd: -1, billingType: "api" }).costUsd.value).toBeNull();
    expect(readSpsUsageEvidence({ spsUsageEvidence: { schemaVersion: 1, costUsd: { value: 2, provenance: "reported" }, currency: "KRW" } }).costUsd.value).toBeNull();
  });
  it("fails closed on invalid stored provenance and metric values", () => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 10 }, usageBasis: "per_run" });
    expect(readSpsUsageEvidence({ spsUsageEvidence: { ...evidence, inputTokens: { value: 10, provenance: "guessed" }, outputTokens: { value: -4, provenance: "reported" }, costBasis: "incremental_api" } })).toMatchObject({ inputTokens: { value: null }, outputTokens: { value: null }, costBasis: "unknown" });
  });
  it("exposes only snapshotted runtime and safe metadata, not configuration or raw errors", () => {
    const observed = observeSpsAgentRun({ ...run, contextSnapshot: { spsPluginConversation: { sessionId: "session", message: "secret prompt" }, spsExecutionRuntime: { adapterType: "codex_local" }, env: { TOKEN: "secret" } }, usageJson: { model: "gpt-6-luna", stdout: "secret output" }, errorCode: "secret-error" }, "plugin");
    expect(observed).toMatchObject({ runtime: { kind: "codex_local", model: "gpt-6-luna", modelSource: "reported" }, elapsedMs: 90, failure: null });
    expect(JSON.stringify(observed)).not.toContain("secret");
    expect(observeSpsAgentRun(run, "plugin").runtime.kind).toBeNull();
    for (const model of ["C:/private/file", "https://private", "../private", "a@private.example", "sk-live-test-secret", "github_pat_fake", "eyJfake.jwt.token"]) {
      expect(observeSpsAgentRun({ ...run, usageJson: { model } }, "plugin").runtime.model).toBeNull();
    }
  });
  it("distinguishes cancellation intent from process termination", () => {
    const pending = { ...run, status: "cancelled", contextSnapshot: { spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending" } };
    expect(observeSpsAgentRun(pending, "plugin")).toMatchObject({ status: "cancelled", phase: "stopping", termination: "pending", cancellationRequested: true });
    expect(observeSpsAgentRun({ ...pending, contextSnapshot: { ...pending.contextSnapshot, spsSessionCancellationTermination: "confirmed" } }, "plugin")).toMatchObject({ phase: "cancelled", termination: "confirmed" });
  });
  it("classifies known failures without authorizing automatic retries", () => {
    expect(observeSpsAgentRun({ ...run, status: "failed", errorCode: "provider_quota" }, "plugin").failure).toEqual({ category: "provider_limit", code: "provider_quota", retrySafety: "requires_review" });
    expect(observeSpsAgentRun({ ...run, status: "failed", errorCode: "raw secret" }, "plugin").failure).toEqual({ category: "execution", code: null, retrySafety: "requires_review" });
    expect(observeSpsAgentRun({ ...run, status: "timed_out" }, "plugin").failure?.category).toBe("timeout");
  });
  it("does not infer Node model, usage or cost from command arguments", () => {
    const node = { ...run, pluginKey: "plugin", subjectKey: "subject", command: "codex", timedOut: 0 };
    expect(observeSpsNodeRun(node)).toMatchObject({ runtime: { kind: "codex_cli", model: null }, usage: unavailableSpsUsage() });
    expect(observeSpsNodeRun({ ...node, status: "cancelling" })).toMatchObject({ phase: "stopping", termination: "pending" });
    expect(observeSpsNodeRun({ ...node, status: "failed", timedOut: 1 }).failure?.category).toBe("timeout");
  });
  it("does not invent queued duration and rejects invalid clock intervals", () => {
    expect(observeSpsAgentRun({ ...run, startedAt: null }, "plugin").elapsedMs).toBeNull();
    expect(observeSpsAgentRun({ ...run, status: "running", finishedAt: null }, "plugin", 55).elapsedMs).toBe(45);
    expect(observeSpsAgentRun({ ...run, finishedAt: null }, "plugin", 55).elapsedMs).toBeNull();
    expect(observeSpsAgentRun({ ...run, finishedAt: new Date(1) }, "plugin").elapsedMs).toBeNull();
  });
});
