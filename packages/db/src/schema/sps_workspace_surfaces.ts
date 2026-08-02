import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const spsWorkspaceShellSettings = pgTable(
  "sps_workspace_shell_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    providerPluginId: uuid("provider_plugin_id")
      .references(() => plugins.id, { onDelete: "set null" }),
    providerPluginKey: text("provider_plugin_key"),
    shellId: text("shell_id"),
    selectedByUserId: text("selected_by_user_id"),
    fallbackReason: text("fallback_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("sps_workspace_shell_settings_company_uq").on(table.companyId),
    providerIdx: index("sps_workspace_shell_settings_provider_idx").on(table.providerPluginId),
  }),
);

export const spsDashboardLayoutItems = pgTable(
  "sps_dashboard_layout_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    widgetId: text("widget_id").notNull(),
    size: text("size").$type<"small" | "medium" | "large" | "full">().notNull(),
    position: integer("position").notNull(),
    collapsed: boolean("collapsed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("sps_dashboard_layout_company_user_idx").on(table.companyId, table.userId),
    companyUserWidgetUq: uniqueIndex("sps_dashboard_layout_company_user_widget_uq").on(
      table.companyId,
      table.userId,
      table.pluginId,
      table.widgetId,
    ),
  }),
);

export const spsPluginInboxItems = pgTable(
  "sps_plugin_inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourcePluginId: uuid("source_plugin_id")
      .references(() => plugins.id, { onDelete: "set null" }),
    sourcePluginKey: text("source_plugin_key").notNull(),
    externalId: text("external_id").notNull(),
    targetUserId: text("target_user_id"),
    category: text("category").notNull(),
    severity: text("severity")
      .$type<"info" | "success" | "warning" | "error">()
      .notNull()
      .default("info"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    navigationTarget: text("navigation_target"),
    actionIds: jsonb("action_ids").$type<string[]>().notNull().default([]),
    opaqueReference: jsonb("opaque_reference").$type<Record<string, unknown>>().notNull().default({}),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("sps_plugin_inbox_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    sourceIdx: index("sps_plugin_inbox_source_idx").on(table.sourcePluginId),
    companySourceExternalUq: uniqueIndex("sps_plugin_inbox_company_source_external_uq").on(
      table.companyId,
      table.sourcePluginKey,
      table.externalId,
    ),
  }),
);

export const spsPluginInboxUserStates = pgTable(
  "sps_plugin_inbox_user_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => spsPluginInboxItems.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("sps_plugin_inbox_state_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    itemUserUq: uniqueIndex("sps_plugin_inbox_state_item_user_uq").on(table.itemId, table.userId),
  }),
);
