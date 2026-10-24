import { describe, expect, it } from "vitest";
import { normalizeSpsPluginExecutionTimeout } from "../services/sps-execution-timeout.js";

describe("normalizeSpsPluginExecutionTimeout", () => {
  it.each([undefined, null])("preserves an unset timeout (%s) as null", (value) => {
    expect(normalizeSpsPluginExecutionTimeout(value)).toBeNull();
  });

  it.each([
    [1, 1_000],
    [999, 1_000],
    [1_000, 1_000],
    [1_001, 1_001],
  ])("normalizes the lower bound for %i ms", (value, expected) => {
    expect(normalizeSpsPluginExecutionTimeout(value)).toBe(expected);
  });

  it.each([
    [14_400_000, 14_400_000],
    [14_400_001, 14_400_000],
    [Number.MAX_SAFE_INTEGER, 14_400_000],
  ])("normalizes the upper bound for %i ms", (value, expected) => {
    expect(normalizeSpsPluginExecutionTimeout(value)).toBe(expected);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["numeric string", "1000"],
    ["boolean", true],
    ["object", {}],
  ])("rejects %s input", (_label, value) => {
    expect(() => normalizeSpsPluginExecutionTimeout(value)).toThrowError(/timeout/);
  });
});
