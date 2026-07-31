import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import type {
  PluginLifecycleProposalEvidenceRef,
  PluginLifecycleProposalOperation,
  PluginLifecycleProposalRiskSummary,
  PluginLifecycleProposalStatus,
  PluginLifecycleProposalTarget,
} from "@paperclipai/shared";

/**
 * Durable, company-scoped intent records. A proposal is never executable by
 * itself: decisions are recorded separately in append-only event rows.
 */
export const pluginLifecycleProposals = pgTable(
  "plugin_lifecycle_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    operation: text("operation").$type<PluginLifecycleProposalOperation>().notNull(),
    status: text("status").$type<PluginLifecycleProposalStatus>().notNull().default("pending"),
    targetJson: jsonb("target_json").$type<PluginLifecycleProposalTarget>().notNull(),
    rationale: text("rationale").notNull(),
    authoringSessionId: text("authoring_session_id").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<PluginLifecycleProposalEvidenceRef[]>().notNull().default([]),
    riskSummary: jsonb("risk_summary").$type<PluginLifecycleProposalRiskSummary>().notNull(),
    createdByPluginId: uuid("created_by_plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    decisionByUserId: uuid("decision_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    decisionReason: text("decision_reason"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("plugin_lifecycle_proposals_company_created_idx").on(table.companyId, table.createdAt),
    statusIdx: index("plugin_lifecycle_proposals_status_idx").on(table.status),
  }),
);

/** Immutable audit trail for every proposal state transition or execution outcome. */
export const pluginLifecycleProposalEvents = pgTable(
  "plugin_lifecycle_proposal_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => pluginLifecycleProposals.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalCreatedIdx: index("plugin_lifecycle_proposal_events_proposal_created_idx").on(table.proposalId, table.createdAt),
    companyCreatedIdx: index("plugin_lifecycle_proposal_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
