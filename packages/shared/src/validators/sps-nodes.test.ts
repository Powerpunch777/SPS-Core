import { describe, expect, it } from "vitest";
import {
  spsNodeCommandCompleteSchema,
  spsNodeUsageReportSchema,
  spsPluginNodeRunCompleteSchema,
} from "./sps-nodes.js";

const validUsageReport = {
  schemaVersion: 1,
  source: "claude_model_usage_v1",
  inputTokens: 0,
  cachedInputTokens: null,
  outputTokens: null,
} as const;

describe("spsNodeUsageReportSchema", () => {
  it("accepts an explicit zero as reported usage", () => {
    expect(spsNodeUsageReportSchema.parse(validUsageReport)).toEqual(validUsageReport);
  });

  it("accepts partial token values with explicit nulls", () => {
    const report = { ...validUsageReport, inputTokens: null, cachedInputTokens: 12 };
    expect(spsNodeUsageReportSchema.parse(report)).toEqual(report);
  });

  it("rejects a report with no non-null token counts", () => {
    expect(() => spsNodeUsageReportSchema.parse({
      ...validUsageReport,
      inputTokens: null,
    })).toThrow();
  });

  it("requires every token-count field, even when its value is null", () => {
    for (const field of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
      const incompleteReport = Object.fromEntries(
        Object.entries(validUsageReport).filter(([key]) => key !== field),
      );
      expect(() => spsNodeUsageReportSchema.parse(incompleteReport)).toThrow();
    }
  });

  it("accepts the maximum safe integer", () => {
    const report = { ...validUsageReport, inputTokens: Number.MAX_SAFE_INTEGER };
    expect(spsNodeUsageReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ["negative values", -1],
    ["fractional values", 1.5],
    ["values above the safe integer limit", Number.MAX_SAFE_INTEGER + 1],
    ["numeric strings", "1"],
  ])("rejects %s", (_description, inputTokens) => {
    expect(() => spsNodeUsageReportSchema.parse({ ...validUsageReport, inputTokens })).toThrow();
  });

  it.each([
    ["unsupported schema versions", { schemaVersion: 2 }],
    ["unsupported usage sources", { source: "other_usage_v1" }],
  ])("rejects %s", (_description, override) => {
    expect(() => spsNodeUsageReportSchema.parse({ ...validUsageReport, ...override })).toThrow();
  });

  it("rejects unknown fields, including cost, model, and freeform data", () => {
    for (const field of ["extra", "costUsd", "model", "metadata"]) {
      expect(() => spsNodeUsageReportSchema.parse({ ...validUsageReport, [field]: "not allowed" })).toThrow();
    }
  });
});

describe("spsPluginNodeRunCompleteSchema", () => {
  it("accepts legacy completion payloads without a usage report", () => {
    const legacyCompletion = { status: "succeeded", exitCode: 0 } as const;

    expect(spsNodeCommandCompleteSchema.parse(legacyCompletion)).toEqual({ ...legacyCompletion, timedOut: false });
    expect(spsPluginNodeRunCompleteSchema.parse(legacyCompletion)).toEqual({ ...legacyCompletion, timedOut: false });
  });

  it("accepts a usage report alongside signed-envelope fields", () => {
    const completion = {
      status: "succeeded",
      exitCode: 0,
      timestamp: "2026-10-24T00:00:00.000Z",
      nonce: "signed-request-nonce",
      signature: "signed-request-signature",
      usageReport: validUsageReport,
    } as const;

    expect(spsPluginNodeRunCompleteSchema.parse(completion)).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
      usageReport: validUsageReport,
    });
    expect(spsNodeCommandCompleteSchema.parse(completion)).not.toHaveProperty("usageReport");
  });

  it("keeps completion envelope keys non-strict while usage reports stay strict", () => {
    expect(() => spsPluginNodeRunCompleteSchema.parse({
      status: "succeeded",
      exitCode: 0,
      timestamp: "2026-10-24T00:00:00.000Z",
      usageReport: { ...validUsageReport, unexpected: true },
    })).toThrow();
  });
});
