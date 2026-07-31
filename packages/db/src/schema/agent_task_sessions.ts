import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentTaskSessions = pgTable(
  "agent_task_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    userId: text("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    adapterType: text("adapter_type").notNull(),
    taskKey: text("task_key").notNull(),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    sessionDisplayId: text("session_display_id"),
    contextJson: jsonb("context_json").$type<import("@paperclipai/shared").AgentSessionContext>(),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("active"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    companyAgentTaskUniqueIdx: uniqueIndex("agent_task_sessions_company_agent_adapter_task_uniq")
      .on(
        table.companyId,
        table.agentId,
        table.adapterType,
        table.taskKey,
      )
      .where(sql`${table.userId} is null`),
    companyUserAgentTaskUniqueIdx: uniqueIndex("agent_task_sessions_company_user_agent_adapter_task_uniq").on(
      table.companyId,
      table.userId,
      table.agentId,
      table.adapterType,
      table.taskKey,
    ).where(sql`${table.userId} is not null`),
    companyUserActiveAssistantUniqueIdx: uniqueIndex("agent_task_sessions_company_user_active_assistant_uniq").on(
      table.companyId,
      table.userId,
      table.agentId,
    ).where(sql`${table.userId} is not null and ${table.status} = 'active' and ${table.taskKey} like 'sps-marketplace-assistant:%'`),
    companyAgentUpdatedIdx: index("agent_task_sessions_company_agent_updated_idx").on(
      table.companyId,
      table.agentId,
      table.updatedAt,
    ),
    companyTaskUpdatedIdx: index("agent_task_sessions_company_task_updated_idx").on(
      table.companyId,
      table.taskKey,
      table.updatedAt,
    ),
  }),
);
