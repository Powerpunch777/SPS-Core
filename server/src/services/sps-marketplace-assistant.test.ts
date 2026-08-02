import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentTaskSessions,
  authUsers,
  companies,
  createDb,
  spsMarketplaceAssistantMessages,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { createSpsMarketplaceAssistantService } from "./sps-marketplace-assistant.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("SPS Marketplace Assistant service", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let userId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-marketplace-assistant-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (companyId) {
      const sessions = await db.select({ id: agentTaskSessions.id })
        .from(agentTaskSessions)
        .where(eq(agentTaskSessions.companyId, companyId));
      for (const session of sessions) {
        await db.delete(spsMarketplaceAssistantMessages)
          .where(eq(spsMarketplaceAssistantMessages.sessionId, session.id));
      }
      await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
    }
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    if (companyId) await db.delete(companies).where(eq(companies.id, companyId));
    if (userId) await db.delete(authUsers).where(eq(authUsers.id, userId));
    companyId = "";
    agentId = "";
    userId = "";
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    companyId = randomUUID();
    userId = `marketplace-user-${randomUUID()}`;
    const company = await db.insert(companies).values({
      id: companyId,
      name: "Marketplace Assistant Test Company",
      issuePrefix: `MA${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    await db.insert(authUsers).values({
      id: userId,
      name: "Marketplace User",
      email: `${userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Marketplace Agent",
    }).returning().then((rows) => rows[0]!);
    agentId = agent.id;
    return {
      companyId: company.id,
      agentId: agent.id,
      userId,
      adapterType: "codex_local",
    };
  }

  it("reuses one transcript and Provider session row per company, user, and agent", async () => {
    const input = await fixture();
    const service = createSpsMarketplaceAssistantService(db);
    const first = await service.getOrCreateSession(input);
    await db.update(agentTaskSessions).set({
      sessionDisplayId: "provider-session-1",
      sessionParamsJson: { sessionId: "provider-session-1" },
    }).where(eq(agentTaskSessions.id, first.id));
    const second = await service.getOrCreateSession(input);
    expect(second.id).toBe(first.id);
    expect(second.sessionDisplayId).toBe("provider-session-1");
    expect(second.userId).toBe(input.userId);
    expect(second.status).toBe("active");
  });

  it("deduplicates a run and paginates transcript messages", async () => {
    const input = await fixture();
    const service = createSpsMarketplaceAssistantService(db);
    const session = await service.getOrCreateSession(input);
    const first = await service.appendMessage({ sessionId: session.id, runId: "run-1", idempotencyKey: "user:run-1", role: "user", content: "Find plugins" });
    const duplicate = await service.appendMessage({ sessionId: session.id, runId: "run-1", idempotencyKey: "user:run-1", role: "user", content: "different retry" });
    expect(duplicate.id).toBe(first.id);
    const second = await service.appendMessage({ sessionId: session.id, runId: "run-1", idempotencyKey: "assistant:run-1", role: "assistant", content: "Results" });
    await db.execute(sql`
      update sps_marketplace_assistant_messages
      set created_at = '2026-08-02T00:00:00.123456Z'::timestamptz
      where id = ${first.id}
    `);
    await db.execute(sql`
      update sps_marketplace_assistant_messages
      set created_at = '2026-08-02T00:00:00.123789Z'::timestamptz
      where id = ${second.id}
    `);
    const page = await service.listMessages({ sessionId: session.id, limit: 1 });
    expect(page.messages).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await service.listMessages({ sessionId: session.id, after: page.nextCursor!, limit: 10 });
    expect(next.messages.map((message) => message.idempotencyKey)).toEqual(["assistant:run-1"]);
  });

  it("closes a session and rejects further transcript writes", async () => {
    const input = await fixture();
    const service = createSpsMarketplaceAssistantService(db);
    const session = await service.getOrCreateSession(input);
    const closed = await service.closeSession(session.id);
    expect(closed?.status).toBe("closed");
    await expect(service.appendMessage({
      sessionId: session.id,
      runId: "run-after-close",
      idempotencyKey: "user:run-after-close",
      role: "user",
      content: "No longer active",
    })).rejects.toThrow("closed");
  });
});
