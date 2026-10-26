import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { z } from "zod/v3";

const require = createRequire(import.meta.url);
const commonJsZod = require("zod/v3") as typeof import("zod/v3");
const ISSUE_LIMIT = 100;
const OVERFLOW_MESSAGE = "Too many validation issues; additional issues omitted.";

function recursiveIssueCount(value: unknown, seen = new Set<object>()): number {
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((count, entry) => count + recursiveIssueCount(entry, seen), 0);
  const issue = value as Record<string, unknown>;
  let count = typeof issue.code === "string" && Array.isArray(issue.path) ? 1 : 0;
  for (const key of ["unionErrors", "argumentsError", "returnTypeError", "issues"]) {
    count += recursiveIssueCount(issue[key], seen);
  }
  return count;
}

const badElements = Array.from({ length: 10_000 }, () => ({ invalid: true }));

describe("patched Zod v3 validation issue budget", () => {
  it("bounds issues across an unbounded array while keeping the parse invalid", () => {
    const result = z.array(z.string()).safeParse(badElements);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected an invalid array");
    expect(result.error.issues).toHaveLength(ISSUE_LIMIT);
    expect(recursiveIssueCount(result.error)).toBe(ISSUE_LIMIT);
    expect(result.error.issues.at(-1)).toMatchObject({ code: "custom", path: [], message: OVERFLOW_MESSAGE });
  });

  it("does not accept a caller-supplied issue budget", () => {
    const result = z.array(z.string()).safeParse(badElements, {
      issueBudget: { count: 0, truncated: false, rootIssues: [] },
    } as never);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected an invalid array");
    expect(recursiveIssueCount(result.error)).toBe(ISSUE_LIMIT);
    expect(result.error.issues.at(-1)).toMatchObject({ code: "custom", message: OVERFLOW_MESSAGE });
  });

  it("keeps exact paths and messages below the cap", () => {
    const result = z.array(z.string()).safeParse([1, {}]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid elements");
    expect(result.error.issues).toEqual([
      { code: "invalid_type", expected: "string", received: "number", path: [0], message: "Expected string, received number" },
      { code: "invalid_type", expected: "string", received: "object", path: [1], message: "Expected string, received object" },
    ]);
  });

  it("counts nested union errors and keeps a successful later branch successful", () => {
    const nested = z.array(z.union([z.string(), z.number()])).safeParse(badElements);
    expect(nested.success).toBe(false);
    if (nested.success) throw new Error("Expected nested invalid union elements");
    expect(recursiveIssueCount(nested.error)).toBe(ISSUE_LIMIT);

    const noisyBranch = z.object({ tag: z.string() }).superRefine((_value, context) => {
      for (let index = 0; index < 150; index++) {
        context.addIssue({ code: "custom", path: ["branch", index], message: `branch-${index}` });
      }
    });
    expect(z.union([noisyBranch, z.any()]).safeParse({ tag: "fallback" }).success).toBe(true);
  });

  it("preserves catch defaults and reports a late refinement failure", () => {
    expect(z.array(z.string()).catch(["default"]).safeParse(badElements)).toEqual({ success: true, data: ["default"] });

    const result = z.array(z.any().superRefine((_value, context) => {
      context.addIssue({ code: "custom", message: "element invalid" });
    })).superRefine((_value, context) => context.addIssue({ code: "custom", message: "late invalid" }))
      .safeParse(Array.from({ length: 200 }, () => "bad"));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected late refinement failure");
    expect(recursiveIssueCount(result.error)).toBe(ISSUE_LIMIT);
  });

  it("bounds asynchronous nested validation and function argument/return errors", async () => {
    const nested = await z.array(z.array(z.string().refine(async () => false)))
      .safeParseAsync(Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => "bad")));
    expect(nested.success).toBe(false);
    if (nested.success) throw new Error("Expected nested async failures");
    expect(recursiveIssueCount(nested.error)).toBe(ISSUE_LIMIT);

    const argumentsValidator = z.function().args(z.array(z.string())).returns(z.array(z.string()))
      .implement(value => value);
    let argumentError: unknown;
    try { argumentsValidator(badElements); } catch (error) { argumentError = error; }
    expect(argumentError).toBeInstanceOf(z.ZodError);
    expect(recursiveIssueCount(argumentError)).toBe(ISSUE_LIMIT);

    const returnsValidator = z.function().args(z.array(z.string())).returns(z.array(z.string()))
      .implement(() => badElements);
    let returnError: unknown;
    try { returnsValidator(["valid"]); } catch (error) { returnError = error; }
    expect(returnError).toBeInstanceOf(z.ZodError);
    expect(recursiveIssueCount(returnError)).toBe(ISSUE_LIMIT);
  });

  it("resets function argument and return budgets for each invocation", async () => {
    const syncFunction = z.function().args(z.array(z.string())).returns(z.array(z.string()))
      .implement(value => value);
    for (let call = 0; call < 105; call++) {
      let error: unknown;
      try { syncFunction(badElements); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(z.ZodError);
      expect(recursiveIssueCount(error)).toBeLessThanOrEqual(ISSUE_LIMIT);
      expect(recursiveIssueCount(error)).toBeGreaterThan(0);
    }
    expect(syncFunction(["valid"])).toEqual(["valid"]);

    const asyncFunction = z.function().args(z.array(z.string())).returns(z.promise(z.array(z.string())))
      .implement(async value => value);
    for (let call = 0; call < 3; call++) {
      let error: unknown;
      try { await asyncFunction(badElements); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(z.ZodError);
      expect(recursiveIssueCount(error)).toBeLessThanOrEqual(ISSUE_LIMIT);
      expect(recursiveIssueCount(error)).toBeGreaterThan(0);
    }
    await expect(asyncFunction(["valid"])).resolves.toEqual(["valid"]);
  });

  it("applies the same limit to CommonJS Zod v3 consumers", () => {
    const result = commonJsZod.z.array(commonJsZod.z.string()).safeParse(badElements);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected CommonJS parse failure");
    expect(result.error.issues).toHaveLength(ISSUE_LIMIT);
    expect(recursiveIssueCount(result.error)).toBe(ISSUE_LIMIT);
  });
});
