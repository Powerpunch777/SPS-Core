export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type CodexThreadGoal = Readonly<{
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set<CodexThreadGoalStatus>([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
]);

function fail(): never {
  throw new TypeError("Invalid Codex thread goal result.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
  return descriptor.value;
}

function isValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || Number.isNaN(next)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function readObjective(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8000
    || !isValidUnicode(value) || Array.from(value).length > 4000) fail();
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0x7f && codePoint <= 0x9f)) fail();
  }
  return value;
}

function readSafeInteger(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) fail();
  return value;
}

export function parseCodexThreadGoalResult(
  result: unknown,
  expectedThreadId: string,
): CodexThreadGoal | null {
  if (typeof expectedThreadId !== "string" || !UUID.test(expectedThreadId) || !isPlainObject(result)) fail();
  const goalValue = ownDataValue(result, "goal");
  if (goalValue === null) return null;
  if (!isPlainObject(goalValue)) fail();

  const threadId = ownDataValue(goalValue, "threadId");
  const objective = readObjective(ownDataValue(goalValue, "objective"));
  const status = ownDataValue(goalValue, "status");
  const tokenBudgetDescriptor = Object.getOwnPropertyDescriptor(goalValue, "tokenBudget");
  if (tokenBudgetDescriptor && !Object.hasOwn(tokenBudgetDescriptor, "value")) fail();
  const tokenBudgetValue = tokenBudgetDescriptor ? tokenBudgetDescriptor.value : null;
  const tokenBudget = tokenBudgetValue === null ? null : readSafeInteger(tokenBudgetValue, true);
  const tokensUsed = readSafeInteger(ownDataValue(goalValue, "tokensUsed"));
  const timeUsedSeconds = readSafeInteger(ownDataValue(goalValue, "timeUsedSeconds"));
  const createdAt = readSafeInteger(ownDataValue(goalValue, "createdAt"));
  const updatedAt = readSafeInteger(ownDataValue(goalValue, "updatedAt"));

  if (typeof threadId !== "string" || !UUID.test(threadId) || threadId !== expectedThreadId
    || typeof status !== "string" || !STATUSES.has(status as CodexThreadGoalStatus)
    || updatedAt < createdAt) fail();

  return Object.freeze({
    threadId,
    objective,
    status: status as CodexThreadGoalStatus,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  });
}
