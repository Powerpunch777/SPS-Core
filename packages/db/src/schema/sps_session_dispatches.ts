import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Core-owned dispatch receipts, not plugin-writable conversation or workflow state.
export const spsSessionDispatches = pgTable("sps_session_dispatches", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
  // Keep the receipt after a legacy close physically removes the session.
  sessionId: uuid("session_id").notNull(),
  requestId: uuid("request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  state: text("state").notNull().default("pending"),
  runId: uuid("run_id").references(() => heartbeatRuns.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  requestUnique: uniqueIndex("sps_session_dispatches_request_uniq").on(table.companyId, table.pluginId, table.requestId),
  sessionIndex: index("sps_session_dispatches_session_idx").on(table.companyId, table.pluginId, table.sessionId),
}));
