import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { spsNodes } from "./sps_nodes.js";

/**
 * A workflow-neutral source selected on the physical SPS Host. A transport
 * route is optional so an offline Host can use a Source before it shares it.
 * The Host's local filesystem path is intentionally never persisted by Core.
 */
export const spsWorkspaceSources = pgTable(
  "sps_workspace_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    sharePath: text("share_path"),
    status: text("status").notNull().default("active"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUniqueIdx: uniqueIndex("sps_workspace_sources_company_name_unique_idx").on(
      table.companyId,
      table.displayName,
    ),
    companyStatusIdx: index("sps_workspace_sources_company_status_idx").on(table.companyId, table.status),
  }),
);

/**
 * A route credential encrypted to one Member Node's transport key. Core can
 * persist and revoke the envelope but cannot decrypt it.
 */
export const spsWorkspaceSourceNodeGrants = pgTable(
  "sps_workspace_source_node_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => spsWorkspaceSources.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    credentialAlgorithm: text("credential_algorithm").notNull().default("rsa-oaep-sha256"),
    credentialEnvelope: text("credential_envelope").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceNodeUniqueIdx: uniqueIndex("sps_workspace_source_node_grants_source_node_unique_idx").on(
      table.sourceId,
      table.nodeId,
    ),
    companyNodeIdx: index("sps_workspace_source_node_grants_company_node_idx").on(table.companyId, table.nodeId),
  }),
);
