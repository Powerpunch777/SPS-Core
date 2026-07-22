import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * The Core-owned memory-provider choice for a company.
 *
 * Provider data belongs to the provider itself. This table intentionally keeps
 * only the selected provider identity and operational status so a company can
 * change memory strategies without migrating its project or room data through
 * the Core database.
 */
export const companyMemorySettings = pgTable(
  "company_memory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    providerPluginId: uuid("provider_plugin_id")
      .references(() => plugins.id, { onDelete: "set null" }),
    providerKey: text("provider_key"),
    status: text("status").notNull().default("enabled"),
    configuredByUserId: text("configured_by_user_id"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_memory_settings_company_unique_idx").on(table.companyId),
    providerIdx: index("company_memory_settings_provider_idx").on(table.providerPluginId),
  }),
);

/**
 * Idempotent delivery history for provider lifecycle events. The Core stores
 * metadata only; provider payloads and recalled memory never enter this table.
 */
export const companyMemoryLifecycleDeliveries = pgTable(
  "company_memory_lifecycle_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    providerPluginId: uuid("provider_plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerEventUniqueIdx: uniqueIndex("company_memory_lifecycle_provider_event_unique_idx").on(
      table.providerPluginId,
      table.eventId,
    ),
    companyCreatedIdx: index("company_memory_lifecycle_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
