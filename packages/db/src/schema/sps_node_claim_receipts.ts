import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { spsNodes } from "./sps_nodes.js";

/** Durable idempotency receipt for a signed Node claim request. */
export const spsNodeClaimReceipts = pgTable(
  "sps_node_claim_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    kind: text("kind").notNull(),
    requestDigest: text("request_digest").notNull(),
    workspaceExecutionEpoch: text("workspace_execution_epoch").notNull(),
    workId: uuid("work_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    companyNodeRequestUniqueIdx: uniqueIndex("sps_node_claim_receipts_company_node_request_unique_idx").on(
      table.companyId,
      table.nodeId,
      table.requestId,
    ),
    nodeExpiryIdx: index("sps_node_claim_receipts_node_expiry_idx").on(table.nodeId, table.expiresAt),
  }),
);
