import { describe, expect, it } from "vitest";
import { parseCodexThreadGoalResult } from "./app-server-goal-state.js";

const threadId = "123e4567-e89b-42d3-a456-426614174000";

function goal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId,
    objective: "Finish the work",
    status: "active",
    tokenBudget: 1200,
    tokensUsed: 30,
    timeUsedSeconds: 12,
    createdAt: 100,
    updatedAt: 120,
    ...overrides,
  };
}

describe("parseCodexThreadGoalResult", () => {
  it("parses selected provider state, ignores unknown fields, and freezes the result", () => {
    const parsed = parseCodexThreadGoalResult({ goal: { ...goal(), rawLog: "ignored", statusDetail: "ignored" } }, threadId);
    expect(parsed).toEqual(goal());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed && Object.keys(parsed)).toEqual([
      "threadId", "objective", "status", "tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt",
    ]);
  });

  it("returns null for an explicitly cleared goal", () => {
    expect(parseCodexThreadGoalResult({ goal: null }, threadId)).toBeNull();
  });

  it("requires a valid lowercase UUID and exact thread binding", () => {
    expect(() => parseCodexThreadGoalResult({ goal: goal({ threadId: "323e4567-e89b-42d3-a456-426614174000" }) }, threadId))
      .toThrow("Invalid Codex thread goal result.");
    expect(() => parseCodexThreadGoalResult({ goal: goal({ threadId: threadId.toUpperCase() }) }, threadId))
      .toThrow("Invalid Codex thread goal result.");
    expect(() => parseCodexThreadGoalResult({ goal: null }, threadId.toUpperCase()))
      .toThrow("Invalid Codex thread goal result.");
  });

  it("requires plain objects and own data properties for selected fields", () => {
    expect(() => parseCodexThreadGoalResult(Object.assign(Object.create({ inherited: true }), { goal: goal() }), threadId))
      .toThrow("Invalid Codex thread goal result.");
    expect(() => parseCodexThreadGoalResult({}, threadId)).toThrow("Invalid Codex thread goal result.");

    let getterCalls = 0;
    const getterGoal = goal();
    Object.defineProperty(getterGoal, "objective", {
      enumerable: true,
      get() { getterCalls += 1; return "should not be read"; },
    });
    expect(() => parseCodexThreadGoalResult({ goal: getterGoal }, threadId)).toThrow("Invalid Codex thread goal result.");
    expect(getterCalls).toBe(0);
  });

  it("requires own accounting fields and rejects an accessor token budget", () => {
    const missingCounter = goal();
    delete missingCounter.tokensUsed;
    expect(() => parseCodexThreadGoalResult({ goal: missingCounter }, threadId)).toThrow("Invalid Codex thread goal result.");

    let getterCalls = 0;
    const accessorBudget = goal();
    Object.defineProperty(accessorBudget, "tokenBudget", {
      enumerable: true,
      get() { getterCalls += 1; return 500; },
    });
    expect(() => parseCodexThreadGoalResult({ goal: accessorBudget }, threadId)).toThrow("Invalid Codex thread goal result.");
    expect(getterCalls).toBe(0);
  });

  it("accepts every supported status and optional nullable token budget", () => {
    for (const status of ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
      expect(parseCodexThreadGoalResult({ goal: goal({ status, tokenBudget: null }) }, threadId)?.status).toBe(status);
    }
    const omittedBudget = goal();
    delete omittedBudget.tokenBudget;
    expect(parseCodexThreadGoalResult({ goal: omittedBudget }, threadId)?.tokenBudget).toBeNull();
  });

  it("rejects unsupported status and invalid objective text", () => {
    for (const invalid of [
      goal({ status: "done" }),
      goal({ objective: " \t\n" }),
      goal({ objective: "x".repeat(4001) }),
      goal({ objective: "bad\u0000text" }),
      goal({ objective: "bad\u000btext" }),
      goal({ objective: "lone surrogate \ud800" }),
    ]) {
      expect(() => parseCodexThreadGoalResult({ goal: invalid }, threadId)).toThrow("Invalid Codex thread goal result.");
    }
    expect(parseCodexThreadGoalResult({ goal: goal({ objective: "line one\r\nline two\tok" }) }, threadId)?.objective)
      .toBe("line one\r\nline two\tok");
    expect(parseCodexThreadGoalResult({ goal: goal({ objective: "🙂".repeat(4000) }) }, threadId)?.objective)
      .toBe("🙂".repeat(4000));
  });

  it("rejects invalid counters, timestamps, and token budgets", () => {
    const invalidGoals = [
      goal({ tokenBudget: 0 }),
      goal({ tokenBudget: Number.MAX_SAFE_INTEGER + 1 }),
      goal({ tokenBudget: "100" }),
      goal({ tokensUsed: -1 }),
      goal({ tokensUsed: Number.MAX_SAFE_INTEGER + 1 }),
      goal({ timeUsedSeconds: 1.5 }),
      goal({ createdAt: -1 }),
      goal({ updatedAt: 99 }),
    ];
    for (const invalid of invalidGoals) {
      expect(() => parseCodexThreadGoalResult({ goal: invalid }, threadId)).toThrow("Invalid Codex thread goal result.");
    }
  });
});
