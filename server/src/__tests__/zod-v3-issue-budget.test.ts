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
// Deliberately violate the static contract to exercise runtime function guards.
const invalidStringArray = badElements as unknown as string[];

function trackedArray(length: number, value: unknown = "valid") {
  let elementReads = 0;
  const input = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return length;
      if (typeof property === "string" && /^\d+$/.test(property)) {
        if (++elementReads > 1024) throw new Error("Invalid collection traversal exceeded its bound");
        return value;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { input, elementReads: () => elementReads };
}

class TrackedSet<T> extends Set<T> {
  iterations = 0;

  override values() {
    this.iterations++;
    return super.values();
  }
}

describe("patched Zod v3 validation issue budget", () => {
  it("stops invalid unbounded collection work without rejecting valid union alternatives", async () => {
    for (const runtime of [z, commonJsZod.z]) {
      for (const async of [false, true]) {
        const tracked = trackedArray(100_000_000, async ? "bad" : 1);
        const schema = runtime.array(async ? runtime.string().refine(async () => false) : runtime.string());
        const result = async ? await schema.safeParseAsync(tracked.input) : schema.safeParse(tracked.input);
        expect(result.success).toBe(false);
        expect(tracked.elementReads()).toBeLessThanOrEqual(async ? 128 : 100);
        let setReads = 0, mapReads = 0;
        class CountingSet extends Set<number> {
          override *values() { for (const value of super.values()) { setReads++; yield value; } return undefined; }
        }
        class CountingMap extends Map<number, number> {
          override *entries() { for (const pair of super.entries()) { mapReads++; yield pair; } return undefined; }
        }
        const set = new CountingSet(Array.from({ length: 250 }, (_, index) => index));
        const map = new CountingMap(Array.from({ length: 250 }, (_, index) => [index, index] as [number, number]));
        const element = async ? runtime.string().refine(async () => false) : runtime.string();
        const setSchema = runtime.set(element), mapSchema = runtime.map(element, element);
        expect((async ? await setSchema.safeParseAsync(set) : setSchema.safeParse(set)).success).toBe(false);
        expect((async ? await mapSchema.safeParseAsync(map) : mapSchema.safeParse(map)).success).toBe(false);
        expect(setReads).toBeLessThanOrEqual(128);
        expect(mapReads).toBeLessThanOrEqual(128);
        const numbers = Array.from({ length: 250 }, (_, index) => index);
        const alternatives = runtime.array(runtime.union([runtime.string(), runtime.number()]));
        expect(async ? await alternatives.parseAsync(numbers) : alternatives.parse(numbers)).toEqual(numbers);
      }
    }
  });

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

  it("rejects over-cap arrays before reading elements in sync and async modes", async () => {
    let syncTransforms = 0;
    const syncMax = trackedArray(4);
    const maxResult = z.array(z.string().transform(value => {
      syncTransforms++;
      return value;
    })).max(2).safeParse(syncMax.input);
    expect(maxResult.success).toBe(false);
    if (maxResult.success) throw new Error("Expected max length failure");
    expect(maxResult.error.issues).toHaveLength(1);
    expect(maxResult.error.issues[0]).toMatchObject({ code: "too_big", maximum: 2, type: "array", exact: false });
    expect(syncMax.elementReads()).toBe(0);
    expect(syncTransforms).toBe(0);

    const syncExact = trackedArray(4);
    const exactResult = z.array(z.string()).length(2).safeParse(syncExact.input);
    expect(exactResult.success).toBe(false);
    if (exactResult.success) throw new Error("Expected exact length failure");
    expect(exactResult.error.issues[0]).toMatchObject({ code: "too_big", maximum: 2, type: "array", exact: true });
    expect(syncExact.elementReads()).toBe(0);

    let asyncTransforms = 0;
    const asyncMax = trackedArray(4);
    const asyncMaxResult = await z.array(z.string().transform(async value => {
      asyncTransforms++;
      return value;
    })).max(2).safeParseAsync(asyncMax.input);
    expect(asyncMaxResult.success).toBe(false);
    expect(asyncMax.elementReads()).toBe(0);
    expect(asyncTransforms).toBe(0);

    const asyncExact = trackedArray(4);
    const asyncExactResult = await z.array(z.string()).length(2).safeParseAsync(asyncExact.input);
    expect(asyncExactResult.success).toBe(false);
    if (asyncExactResult.success) throw new Error("Expected async exact length failure");
    expect(asyncExactResult.error.issues[0]).toMatchObject({ code: "too_big", maximum: 2, type: "array", exact: true });
    expect(asyncExact.elementReads()).toBe(0);
  });

  it("rejects over-cap sets before iterating values", async () => {
    const syncSet = new TrackedSet(["one", "two", "three"]);
    const syncResult = z.set(z.string().transform(value => value)).max(2).safeParse(syncSet);
    expect(syncResult.success).toBe(false);
    if (syncResult.success) throw new Error("Expected max set size failure");
    expect(syncResult.error.issues[0]).toMatchObject({ code: "too_big", maximum: 2, type: "set" });
    expect(syncSet.iterations).toBe(0);

    let asyncTransforms = 0;
    const asyncSet = new TrackedSet(["one", "two", "three"]);
    const asyncResult = await z.set(z.string().transform(async value => {
      asyncTransforms++;
      return value;
    })).max(2).safeParseAsync(asyncSet);
    expect(asyncResult.success).toBe(false);
    expect(asyncSet.iterations).toBe(0);
    expect(asyncTransforms).toBe(0);
  });

  it("keeps valid bounded array transforms, refinements, catches, and union branches", () => {
    let transformCalls = 0;
    let refinementCalls = 0;
    const bounded = z.array(z.string().transform(value => {
      transformCalls++;
      return value.toUpperCase();
    })).max(2).superRefine(() => {
      refinementCalls++;
    });
    const valid = bounded.safeParse(["ok"]);
    expect(valid).toEqual({ success: true, data: ["OK"] });
    expect(transformCalls).toBe(1);
    expect(refinementCalls).toBe(1);

    expect(z.array(z.string()).max(2).catch(["fallback"]).safeParse(["a", "b", "c"]))
      .toEqual({ success: true, data: ["fallback"] });
    expect(z.union([z.array(z.string()).max(2), z.string()]).parse(["ok"])).toEqual(["ok"]);
    expect(z.union([z.array(z.string()).max(2), z.string()]).parse("fallback")).toBe("fallback");

    let oversizedRefinementCalls = 0;
    const oversized = z.array(z.string()).max(2).superRefine(() => {
      oversizedRefinementCalls++;
    }).safeParse(["one", "two", "three"]);
    expect(oversized.success).toBe(false);
    expect(oversizedRefinementCalls).toBe(0);
  });

  it("omits child diagnostics for oversized invalid bounded arrays", () => {
    const result = z.array(z.string()).max(2).safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid oversized elements");
    expect(result.error.issues.map(issue => issue.code)).toEqual(["too_big"]);

    const unionResult = z.union([z.array(z.string()).max(2), z.object({ ok: z.number() })])
      .safeParse(["one", "two", "three"]);
    expect(unionResult.success).toBe(false);
    if (unionResult.success) throw new Error("Expected invalid union input");
    expect(unionResult.error.issues.map(issue => issue.code)).toEqual(["invalid_union"]);
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
    try { argumentsValidator(invalidStringArray); } catch (error) { argumentError = error; }
    expect(argumentError).toBeInstanceOf(z.ZodError);
    expect(recursiveIssueCount(argumentError)).toBe(ISSUE_LIMIT);

    const returnsValidator = z.function().args(z.array(z.string())).returns(z.array(z.string()))
      .implement(() => invalidStringArray);
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
      try { syncFunction(invalidStringArray); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(z.ZodError);
      expect(recursiveIssueCount(error)).toBeLessThanOrEqual(ISSUE_LIMIT);
      expect(recursiveIssueCount(error)).toBeGreaterThan(0);
    }
    expect(syncFunction(["valid"])).toEqual(["valid"]);

    const asyncFunction = z.function().args(z.array(z.string())).returns(z.promise(z.array(z.string())))
      .implement(async value => value);
    for (let call = 0; call < 3; call++) {
      let error: unknown;
      try { await asyncFunction(invalidStringArray); } catch (caught) { error = caught; }
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

    const tracked = trackedArray(4);
    const oversized = commonJsZod.z.array(commonJsZod.z.string()).max(2).safeParse(tracked.input);
    expect(oversized.success).toBe(false);
    expect(tracked.elementReads()).toBe(0);

    const trackedSet = new TrackedSet(["one", "two", "three"]);
    const oversizedSet = commonJsZod.z.set(commonJsZod.z.string()).max(2).safeParse(trackedSet);
    expect(oversizedSet.success).toBe(false);
    expect(trackedSet.iterations).toBe(0);
  });

  it("keeps return validation diagnostics after successful noisy arguments", async () => {
    for (const runtime of [z, commonJsZod.z]) {
      const argumentsSchema = runtime.array(runtime.union([runtime.string(), runtime.number()]));
      const values = Array.from({ length: 250 }, () => 1);
      const fn = runtime.function().args(argumentsSchema).returns(runtime.string()).implement(() => 42 as never);
      let error: unknown;
      try { fn(values); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(runtime.ZodError);
      const issues = (error as InstanceType<typeof runtime.ZodError>).issues;
      expect(issues[0]?.code).toBe("invalid_return_type");
      expect(recursiveIssueCount(error)).toBe(2);

      const asyncFn = runtime.function().args(argumentsSchema).returns(runtime.promise(runtime.string()))
        .implement(async () => 42 as never);
      let asyncError: unknown;
      try { await asyncFn(values); } catch (caught) { asyncError = caught; }
      expect(asyncError).toBeInstanceOf(runtime.ZodError);
      expect(recursiveIssueCount(asyncError)).toBe(2);
    }
  });

  it("does not traverse values appended by collection callbacks", async () => {
    for (const runtime of [z, commonJsZod.z]) {
      for (const async of [false, true]) {
        for (const kind of ["array", "set", "map"] as const) {
          const input = kind === "array" ? ["first"] : kind === "set" ? new Set(["first"]) : new Map([["first", "first"]]);
          let calls = 0;
          const append = (value: string) => {
            if (++calls > 3) throw new Error("Unexpected traversal of appended values");
            if (Array.isArray(input)) input.push(`next-${calls}`);
            else if (input instanceof Set) input.add(`next-${calls}`);
            else input.set(`next-${calls}`, `next-${calls}`);
            return value;
          };
          const element = runtime.string().transform(async ? async value => append(value) : append);
          const schema = kind === "array" ? runtime.array(element) : kind === "set" ? runtime.set(element)
            : runtime.map(runtime.string(), element);
          const result = async ? await schema.parseAsync(input) : schema.parse(input);
          expect(Array.isArray(result) ? result.length : result.size).toBe(1);
          expect(calls).toBe(1);
        }
      }
    }
  });
});
