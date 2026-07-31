import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentTaskSessions } from "./agent_task_sessions.js";

export const spsMarketplaceAssistantMessages = pgTable(
  "sps_marketplace_assistant_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentTaskSessions.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdempotencyUniqueIdx: uniqueIndex("sps_marketplace_assistant_messages_session_idempotency_uniq").on(
      table.sessionId,
      table.idempotencyKey,
    ),
    sessionCreatedIdx: index("sps_marketplace_assistant_messages_session_created_idx").on(
      table.sessionId,
      table.createdAt,
      table.id,
    ),
  }),
);
