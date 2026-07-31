import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, like, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, spsMarketplaceAssistantMessages } from "@paperclipai/db";

export const SPS_MARKETPLACE_ASSISTANT_TASK_KEY = "sps-marketplace-assistant";
export const SPS_MARKETPLACE_ASSISTANT_TASK_KEY_PREFIX = `${SPS_MARKETPLACE_ASSISTANT_TASK_KEY}:`;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type SpsMarketplaceAssistantMessageRole = "user" | "assistant" | "system" | "tool";

export interface SpsMarketplaceAssistantSessionInput {
  companyId: string;
  userId: string;
  agentId: string;
  adapterType: string;
}

export interface ListSpsMarketplaceAssistantMessagesInput {
  sessionId: string;
  limit?: number;
  after?: string;
}

function pageSize(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(value, MAX_PAGE_SIZE);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = new Date(String(parsed.createdAt ?? ""));
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (Number.isNaN(createdAt.getTime()) || !id) throw new Error();
    return { createdAt, id };
  } catch {
    throw new Error("Invalid message pagination cursor.");
  }
}

export function createSpsMarketplaceAssistantService(db: Db) {
  async function getOrCreateSession(input: SpsMarketplaceAssistantSessionInput) {
    const existing = await db
      .select()
      .from(agentTaskSessions)
      .where(and(
        eq(agentTaskSessions.companyId, input.companyId),
        eq(agentTaskSessions.userId, input.userId),
        eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.status, "active"),
        like(agentTaskSessions.taskKey, `${SPS_MARKETPLACE_ASSISTANT_TASK_KEY_PREFIX}%`),
      ))
      .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      if (existing.adapterType === input.adapterType) return existing;
      return db.update(agentTaskSessions).set({
        adapterType: input.adapterType,
        sessionParamsJson: null,
        sessionDisplayId: null,
        lastRunId: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(agentTaskSessions.id, existing.id)).returning().then((rows) => rows[0]!);
    }

    const sessionId = randomUUID();
    const inserted = await db.insert(agentTaskSessions).values({
      id: sessionId,
      companyId: input.companyId,
      userId: input.userId,
      agentId: input.agentId,
      adapterType: input.adapterType,
      taskKey: `${SPS_MARKETPLACE_ASSISTANT_TASK_KEY_PREFIX}${sessionId}`,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return inserted[0];
    return db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.userId, input.userId),
      eq(agentTaskSessions.agentId, input.agentId),
      eq(agentTaskSessions.status, "active"),
      like(agentTaskSessions.taskKey, `${SPS_MARKETPLACE_ASSISTANT_TASK_KEY_PREFIX}%`),
    )).then((rows) => rows[0]!);
  }

  async function getSession(input: { sessionId: string; companyId: string; userId: string }) {
    return db.select().from(agentTaskSessions).where(and(
      eq(agentTaskSessions.id, input.sessionId),
      eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.userId, input.userId),
      like(agentTaskSessions.taskKey, `${SPS_MARKETPLACE_ASSISTANT_TASK_KEY_PREFIX}%`),
    )).then((rows) => rows[0] ?? null);
  }

  async function appendMessage(input: {
    sessionId: string;
    runId: string;
    idempotencyKey: string;
    role: SpsMarketplaceAssistantMessageRole;
    content: string;
    metadata?: Record<string, unknown>;
  }) {
    const session = await db.select({ status: agentTaskSessions.status })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, input.sessionId))
      .then((rows) => rows[0] ?? null);
    if (!session) throw new Error("Marketplace Assistant session not found.");
    if (session.status !== "active") throw new Error("Marketplace Assistant session is closed.");
    const inserted = await db.insert(spsMarketplaceAssistantMessages).values({
      sessionId: input.sessionId,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
    }).onConflictDoNothing().returning();
    if (inserted[0]) return inserted[0];
    return db.select().from(spsMarketplaceAssistantMessages).where(and(
      eq(spsMarketplaceAssistantMessages.sessionId, input.sessionId),
      eq(spsMarketplaceAssistantMessages.idempotencyKey, input.idempotencyKey),
    )).then((rows) => rows[0]!);
  }

  async function listMessages(input: ListSpsMarketplaceAssistantMessagesInput) {
    const limit = pageSize(input.limit);
    const after = decodeCursor(input.after);
    const rows = await db.select().from(spsMarketplaceAssistantMessages).where(
      after === undefined
        ? eq(spsMarketplaceAssistantMessages.sessionId, input.sessionId)
        : and(
          eq(spsMarketplaceAssistantMessages.sessionId, input.sessionId),
          or(
            gt(spsMarketplaceAssistantMessages.createdAt, after.createdAt),
            and(
              eq(spsMarketplaceAssistantMessages.createdAt, after.createdAt),
              gt(spsMarketplaceAssistantMessages.id, after.id),
            ),
          ),
        ),
    ).orderBy(asc(spsMarketplaceAssistantMessages.createdAt), asc(spsMarketplaceAssistantMessages.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages,
      nextCursor: hasMore
        ? encodeCursor(messages[messages.length - 1]!.createdAt, messages[messages.length - 1]!.id)
        : null,
    };
  }

  async function closeSession(sessionId: string) {
    return db.update(agentTaskSessions)
      .set({ status: "closed", closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentTaskSessions.id, sessionId), eq(agentTaskSessions.status, "active")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return { getOrCreateSession, getSession, appendMessage, listMessages, closeSession };
}

export type SpsMarketplaceAssistantService = ReturnType<typeof createSpsMarketplaceAssistantService>;
