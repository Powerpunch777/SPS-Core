import { pgTable, text, uuid } from "drizzle-orm/pg-core";

/** Durable global plugin-definition/configuration authority revision. */
export const spsPluginAuthorityCatalog = pgTable("sps_plugin_authority_catalog", {
  id: text("id").primaryKey(),
  revision: uuid("revision").notNull().defaultRandom(),
});

/** Durable per-Workspace plugin-policy revision; rows intentionally survive Workspace deletion. */
export const spsWorkspacePluginAuthority = pgTable("sps_workspace_plugin_authority", {
  workspaceId: uuid("workspace_id").primaryKey(),
  revision: uuid("revision").notNull().defaultRandom(),
});
