import { describe, expect, it } from "vitest";
import { observeSpsAgentRun, observeSpsNodeRun, buildSpsUsageEvidence } from "../services/sps-execution-observation.js";
import { summarizeSpsExecutions, validateSpsExecutionSummaryOptions } from "../services/sps-execution-summary.js";

const window = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" };
const common = { id: "run", companyId: "workspace", status: "succeeded", createdAt: new Date("2026-10-01T12:00:00.000Z"), startedAt: new Date("2026-10-01T12:00:00.000Z"), finishedAt: new Date("2026-10-01T12:00:00.100Z") };
const agent = (id: string, evidence?: unknown) => observeSpsAgentRun({ ...common, id, agentId: "agent", contextSnapshot: null, usageJson: evidence ? { spsUsageEvidence: evidence } : null, errorCode: null }, "plugin");
const node = () => observeSpsNodeRun({ ...common, pluginKey: "plugin", subjectKey: "work", command: "codex", timedOut: 0 });
const summarize = (rows: ReturnType<typeof agent>[]) => summarizeSpsExecutions("workspace", "plugin", window, rows, Date.parse(window.to));
describe("SPS execution summary", () => {
  it("keeps empty and unmeasured totals null rather than free or zero", () => {
    const empty = summarize([]);
    expect(empty.executionCount).toBe(0);
    expect(empty.tokens.inputTokens).toEqual({ reported: null, estimated: null, reportedExecutions: 0, estimatedExecutions: 0, unavailableExecutions: 0, overflowed: false });
    const unknown = summarize([agent("a"), node()]);
    expect(unknown.tokens.inputTokens).toMatchObject({ reported: null, estimated: null, unavailableExecutions: 2 });
    expect(unknown.costs.other).toMatchObject({ reported: null, unavailableExecutions: 2 });
  });
  it("separates reported, estimated and unavailable coverage, preserving explicit zero", () => {
    const rows = [agent("a", buildSpsUsageEvidence({ usage: { inputTokens: 0, outputTokens: 4 }, usageBasis: "per_run" })),
      agent("b", buildSpsUsageEvidence({ usage: { inputTokens: 100 }, normalizedUsage: { inputTokens: 7 }, usageBasis: "session_cumulative" })), node()];
    expect(summarize(rows).tokens.inputTokens).toEqual({ reported: 0, estimated: 7, reportedExecutions: 1, estimatedExecutions: 1, unavailableExecutions: 1, overflowed: false });
    expect(summarize(rows).tokens.cachedInputTokens.unavailableExecutions).toBe(3);
  });
  it("never combines subscription reference cost with incremental API cost", () => {
    const evidence = (costUsd: number, billingType: string) => buildSpsUsageEvidence({ costUsd, costUsdBasis: "per_run", billingType });
    const summary = summarize([agent("api", evidence(1.25, "api")), agent("sub", evidence(3, "subscription")), agent("unknown", evidence(2, "fixed")), node()]);
    expect(summary.costs.incrementalApi).toMatchObject({ reported: 1.25, reportedExecutions: 1 });
    expect(summary.costs.subscriptionReference).toMatchObject({ reported: 3, reportedExecutions: 1 });
    expect(summary.costs.other).toMatchObject({ reported: 2, reportedExecutions: 1, unavailableExecutions: 1 });
  });
  it("deduplicates exact lane/run snapshots but rejects conflicting duplicates", () => {
    const row = agent("same", buildSpsUsageEvidence({ usage: { inputTokens: 12 }, usageBasis: "per_run" }));
    expect(summarize([row, structuredClone(row)]).tokens.inputTokens.reported).toBe(12);
    expect(summarize([row, structuredClone(row)]).executionCount).toBe(1);
    expect(summarize([{ ...row, runId: "run" }, node()]).executionCount).toBe(2);
    expect(() => summarize([row, { ...row, status: "changed" }])).toThrow("Conflicting");
  });
  it("retains scope and exclusive-end bounds", () => {
    for (const row of [{ ...agent("a"), companyId: "other" }, { ...agent("a"), pluginKey: "other" }, { ...agent("a"), createdAt: window.to }, { ...agent("a"), createdAt: "2026-09-30T23:59:59.999Z" }]) {
      expect(() => summarize([row])).toThrow("scope");
    }
    expect(summarize([{ ...agent("a"), createdAt: window.from }]).executionCount).toBe(1);
    expect(() => summarizeSpsExecutions("workspace", "plugin", { ...window, lane: "node" }, [agent("a")])).toThrow("scope");
  });
  it("does not call pending termination complete", () => {
    const summary = summarize([{ ...agent("a"), phase: "stopping", status: "cancelled", termination: "pending" }, { ...node(), phase: "unknown" }]);
    expect(summary).toMatchObject({ executionCount: 2, terminalCount: 0, inFlightCount: 1, unknownPhaseCount: 1 });
  });
  it("reports numeric overflow as unknown without resetting to zero", () => {
    const large = agent("a", buildSpsUsageEvidence({ usage: { inputTokens: Number.MAX_SAFE_INTEGER }, usageBasis: "per_run" }));
    const small = agent("b", buildSpsUsageEvidence({ usage: { inputTokens: 1 }, usageBasis: "per_run" }));
    expect(summarize([large, small, { ...small, runId: "c" }]).tokens.inputTokens).toMatchObject({ reported: null, reportedExecutions: 3, overflowed: true });
    expect(summarize([{ ...large, elapsedMs: Number.MAX_SAFE_INTEGER }, { ...small, elapsedMs: 1 }]).duration).toMatchObject({ totalMs: null, knownExecutions: 2, overflowed: true });
  });
  it("refuses oversized summaries rather than returning a partial total", () => {
    expect(() => summarize(Array.from({ length: 10001 }, (_, id) => agent(String(id))))).toThrow("narrow");
  });
  it("rejects malformed windows, scope filters and unknown options", () => {
    for (const input of [null, [], {}, { ...window, extra: true }, { ...window, from: "2026-10-01" }, { ...window, to: window.from },
      { ...window, to: "2026-11-02T00:00:00.000Z" }, { ...window, lane: "bad" }, { ...window, agentId: "bad" },
      { ...window, lane: "node", agentId: "11111111-1111-4111-8111-111111111111" }]) expect(() => validateSpsExecutionSummaryOptions(input)).toThrow();
    expect(validateSpsExecutionSummaryOptions({ ...window, agentId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }).agentId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
});
