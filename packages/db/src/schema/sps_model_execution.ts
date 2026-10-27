import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecretBindings } from "./company_secret_bindings.js";
import { companySecrets } from "./company_secrets.js";
import { plugins } from "./plugins.js";

/** Immutable Host-selected egress/model configuration. Credential values never enter these rows. */
export const spsModelConnections = pgTable("sps_model_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  protocol: text("protocol").notNull().default("responses_text_v1"),
  endpoint: text("endpoint").notNull(),
  model: text("model").notNull(),
  secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
  versionSelector: text("version_selector").notNull().default("latest"),
  status: text("status").notNull().default("active"),
  allowLoopbackHttp: boolean("allow_loopback_http").notNull().default(false),
  timeoutMs: integer("timeout_ms").notNull(),
  maxOutputTokens: integer("max_output_tokens").notNull(),
  maxRequestBytes: integer("max_request_bytes").notNull(),
  maxResponseBytes: integer("max_response_bytes").notNull(),
  maxConcurrentRequests: integer("max_concurrent_requests").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ companyCreatedIdx: index("sps_model_connections_company_created_idx").on(table.companyId, table.createdAt) }));

/** Explicit Host approval of one Plugin instance on one immutable model connection. */
export const spsModelGrants = pgTable("sps_model_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => spsModelConnections.id, { onDelete: "cascade" }),
  bindingId: uuid("binding_id").references(() => companySecretBindings.id, { onDelete: "set null" }),
  revision: integer("revision").notNull().default(1),
  status: text("status").notNull().default("active"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  connectionPluginUq: uniqueIndex("sps_model_grants_company_connection_plugin_uq").on(table.companyId, table.connectionId, table.pluginId),
  pluginStatusIdx: index("sps_model_grants_company_plugin_status_idx").on(table.companyId, table.pluginId, table.status),
}));

/** Separate from Node/Agent execution. Inputs are ephemeral; never automatically replay on recovery. */
export const spsModelRuns = pgTable("sps_model_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  pluginId: uuid("plugin_id").notNull(),
  pluginKey: text("plugin_key").notNull(),
  workspaceExecutionEpoch: text("workspace_execution_epoch").notNull().default("0"),
  connectionId: uuid("connection_id").notNull().references(() => spsModelConnections.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").references(() => spsModelGrants.id, { onDelete: "set null" }),
  grantRevision: integer("grant_revision").notNull(),
  credentialVersion: integer("credential_version"),
  requestKey: text("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  status: text("status").notNull().default("queued"),
  externalEffects: text("external_effects").notNull().default("not_dispatched"),
  errorCode: text("error_code"),
  cancellationRequestedAt: timestamp("cancellation_requested_at", { withTimezone: true }),
  resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
  usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
  resourcePending: boolean("resource_pending").notNull().default(true),
  leaseOwnerId: uuid("lease_owner_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  requestKeyUq: uniqueIndex("sps_model_runs_company_plugin_request_key_uq").on(table.companyId, table.pluginId, table.requestKey),
  pluginCreatedIdx: index("sps_model_runs_company_plugin_created_idx").on(table.companyId, table.pluginKey, table.createdAt),
  connectionLeaseIdx: index("sps_model_runs_connection_lease_idx").on(table.connectionId, table.leaseExpiresAt),
}));
