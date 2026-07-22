import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { plugins } from "./plugins.js";
import { projects } from "./projects.js";

/** Explicit Agent grants for plugins that declare `agentToolAccess: explicit_grant`. */
export const pluginToolGrants = pgTable(
  "plugin_tool_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginAgentUniqueIdx: uniqueIndex("plugin_tool_grants_plugin_agent_unique_idx").on(table.pluginId, table.agentId),
    companyAgentIdx: index("plugin_tool_grants_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

/** Payload-free audit trail for plugin tool calls. Do not add parameters here. */
export const pluginToolAuditEvents = pgTable(
  "plugin_tool_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("plugin_tool_audit_company_created_idx").on(table.companyId, table.createdAt),
    pluginCreatedIdx: index("plugin_tool_audit_plugin_created_idx").on(table.pluginId, table.createdAt),
    agentCreatedIdx: index("plugin_tool_audit_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
