import { describe, expect, it } from "vitest";
import { buildSpsUsageEvidence, unavailableSpsUsage } from "../services/sps-execution-usage.js";
import { createSpsExecutionUsageReceipt, readSpsExecutionUsageReceipt, type SpsUsageReceiptScope } from "../services/sps-execution-usage-receipt.js";

const scope: SpsUsageReceiptScope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  agentId: "abcdefab-cdef-4abc-8def-abcdefabcdef",
  pluginKey: "sps.plugin-name",
  sessionId: "44444444-4444-4444-8444-444444444444",
};

const read = (receipt: unknown, expectedScope = scope) => readSpsExecutionUsageReceipt({ spsUsageReceipt: receipt }, expectedScope);

describe("SPS execution usage receipt", () => {
  it("creates deterministic receipts and normalizes UUID casing", () => {
    const upperScope = { ...scope, agentId: scope.agentId.toUpperCase() };
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 0, outputTokens: 8 }, usageBasis: "per_run", costUsd: 0, costUsdBasis: "per_run", billingType: "api" });
    const receipt = createSpsExecutionUsageReceipt(upperScope, evidence);

    expect(receipt.scope.agentId).toBe(scope.agentId);
    expect(createSpsExecutionUsageReceipt(scope, evidence)).toEqual(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.scope)).toBe(true);
    expect(Object.isFrozen(receipt.usage.inputTokens)).toBe(true);
  });

  it("canonicalizes object key order for the digest", () => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 9, outputTokens: 3 }, usageBasis: "per_run" });
    const reorderedEvidence = Object.fromEntries(Object.entries(evidence).reverse());
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "costUsd"] as const) {
      reorderedEvidence[key] = Object.fromEntries(Object.entries(evidence[key]).reverse());
    }
    const reversedScope = Object.fromEntries(Object.entries(scope).reverse()) as unknown as SpsUsageReceiptScope;
    expect(createSpsExecutionUsageReceipt(reversedScope, reorderedEvidence).digest)
      .toBe(createSpsExecutionUsageReceipt(scope, evidence).digest);
  });

  it("rejects receipt hash edits and scope mismatches", () => {
    const receipt = createSpsExecutionUsageReceipt(scope, buildSpsUsageEvidence({ usage: { inputTokens: 5 }, usageBasis: "per_run" }));
    expect(read({ ...receipt, digest: "0".repeat(64) }).state).toBe("invalid");
    expect(read(receipt, { ...scope, sessionId: "55555555-5555-4555-8555-555555555555" }).state).toBe("invalid");
    expect(read({ ...receipt, scope: { ...receipt.scope, runId: "66666666-6666-4666-8666-666666666666" } }).state).toBe("invalid");
  });

  it("rejects unknown fields at every receipt boundary", () => {
    const receipt = createSpsExecutionUsageReceipt(scope, buildSpsUsageEvidence({ usage: { inputTokens: 5 }, usageBasis: "per_run" }));
    expect(read({ ...receipt, extra: "not retained" }).state).toBe("invalid");
    expect(read({ ...receipt, scope: { ...receipt.scope, extra: true } }).state).toBe("invalid");
    expect(read({ ...receipt, usage: { ...receipt.usage, prompt: "secret" } }).state).toBe("invalid");
    expect(read({ ...receipt, usage: { ...receipt.usage, inputTokens: { ...receipt.usage.inputTokens, extra: 1 } } }).state).toBe("invalid");
    expect(() => createSpsExecutionUsageReceipt(scope, { ...buildSpsUsageEvidence({}), secretPayload: "do not retain" })).toThrow();
  });

  it.each([
    ["negative", -1],
    ["fractional token", 1.5],
    ["overflow", Number.MAX_SAFE_INTEGER + 1],
    ["infinite", Infinity],
    ["NaN", NaN],
  ])("rejects %s values instead of normalizing them", (_label, value) => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 1 }, usageBasis: "per_run" });
    expect(() => createSpsExecutionUsageReceipt(scope, { ...evidence, inputTokens: { value, provenance: "reported" } })).toThrow();
  });

  it("rejects invalid provenance and cost-basis combinations", () => {
    const evidence = buildSpsUsageEvidence({ costUsd: 2, costUsdBasis: "per_run", billingType: "api" });
    expect(() => createSpsExecutionUsageReceipt(scope, { ...evidence, inputTokens: { value: 4, provenance: "guessed" } })).toThrow();
    expect(() => createSpsExecutionUsageReceipt(scope, { ...evidence, costBasis: "subscription_reference" })).toThrow();
    expect(() => createSpsExecutionUsageReceipt(scope, { ...evidence, costUsd: { value: 2, provenance: "estimated" } })).toThrow();
  });

  it("distinguishes absent legacy receipts from malformed present receipts", () => {
    expect(readSpsExecutionUsageReceipt({ spsUsageEvidence: buildSpsUsageEvidence({ usage: { inputTokens: 4 }, usageBasis: "per_run" }) }, scope))
      .toEqual({ state: "absent", usage: null });
    expect(readSpsExecutionUsageReceipt(null, scope)).toEqual({ state: "absent", usage: null });
    expect(read({ schemaVersion: "wrong" })).toEqual({ state: "invalid", usage: unavailableSpsUsage() });
  });

  it("preserves unknown values, explicit zeroes, and estimated token provenance", () => {
    const evidence = buildSpsUsageEvidence({
      usage: { inputTokens: 100, outputTokens: 40 },
      normalizedUsage: { inputTokens: 0, outputTokens: 4 },
      usageBasis: "session_cumulative",
      billingType: "subscription",
    });
    const result = read(createSpsExecutionUsageReceipt(scope, evidence));
    expect(result.state).toBe("valid");
    expect(result.usage).toMatchObject({
      inputTokens: { value: 0, provenance: "estimated" },
      cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: 4, provenance: "estimated" },
      costUsd: { value: null, provenance: "unavailable" },
      currency: null,
      billingType: "subscription_included",
      costBasis: "subscription_reference",
    });

    const reported = read(createSpsExecutionUsageReceipt(scope, buildSpsUsageEvidence({ usage: { inputTokens: 0 }, usageBasis: "per_run", costUsd: 0, costUsdBasis: "per_run", billingType: "api" })));
    expect(reported.usage).toMatchObject({ inputTokens: { value: 0, provenance: "reported" }, costUsd: { value: 0, provenance: "reported" }, costBasis: "incremental_api" });
  });

  it("copies evidence into an immutable receipt without retaining later input mutations", () => {
    const evidence = buildSpsUsageEvidence({ usage: { inputTokens: 12 }, usageBasis: "per_run" });
    const receipt = createSpsExecutionUsageReceipt(scope, evidence);
    evidence.inputTokens.value = 900;
    evidence.inputTokens.provenance = "estimated";
    expect(receipt.usage.inputTokens).toEqual({ value: 12, provenance: "reported" });
  });

  it("rejects malformed IDs, plugin keys, and noncanonical stored scope", () => {
    const evidence = buildSpsUsageEvidence({});
    expect(() => createSpsExecutionUsageReceipt({ ...scope, agentId: "not-a-uuid" }, evidence)).toThrow();
    expect(() => createSpsExecutionUsageReceipt({ ...scope, pluginKey: "../plugin" }, evidence)).toThrow();
    expect(() => createSpsExecutionUsageReceipt({ ...scope, pluginKey: "p".repeat(201) }, evidence)).toThrow();
    const receipt = createSpsExecutionUsageReceipt(scope, evidence);
    expect(read({ ...receipt, scope: { ...receipt.scope, agentId: receipt.scope.agentId.toUpperCase() } }).state).toBe("invalid");
  });
});
