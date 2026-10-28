import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/** Nonsecret, schema-validated runtime settings for one Plugin in one Workspace. */
export const spsWorkspacePluginRuntimeConfigs = pgTable(
  "sps_workspace_plugin_runtime_configs",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    revision: uuid("revision").notNull().defaultRandom(),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspacePluginPk: primaryKey({ columns: [table.workspaceId, table.pluginId] }),
  }),
);
