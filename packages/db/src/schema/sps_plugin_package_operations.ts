import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";

/** Host-wide package lifecycle journal; this is internal recovery state, not public SDK or Marketplace data. */
export const spsPluginPackageOperations = pgTable(
  "sps_plugin_package_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No FK: hard uninstall must not erase the journal needed to recover it.
    pluginId: uuid("plugin_id").notNull(),
    pluginKey: text("plugin_key").notNull(),
    kind: text("kind").notNull(),
    snapshotJson: jsonb("snapshot_json").$type<Record<string, unknown>>().notNull(),
    removeData: boolean("remove_data").notNull().default(false),
    activePluginId: uuid("active_plugin_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    activePluginIdx: uniqueIndex("sps_plugin_package_operations_active_plugin_idx").on(table.activePluginId),
    pluginKeyIdx: index("sps_plugin_package_operations_plugin_key_idx").on(table.pluginKey),
    pendingIdx: index("sps_plugin_package_operations_pending_idx").on(table.completedAt),
  }),
);
