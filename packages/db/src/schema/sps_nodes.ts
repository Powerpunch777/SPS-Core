import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigserial,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projects } from "./projects.js";

export type SpsNodeCapability = {
  kind:
    | "claude_cli"
    | "codex_cli"
    | "agy_cli"
    | "gemini_cli"
    | "opencode_cli"
    | "pi_cli"
    | "ollama"
    | "lm_studio"
    | "specialist_api"
    | "custom";
  label: string;
  version?: string | null;
  models?: string[];
};

export const spsNodes = pgTable(
  "sps_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: text("display_name").notNull(),
    publicKey: text("public_key").notNull(),
    platform: text("platform").notNull(),
    appVersion: text("app_version"),
    capabilities: jsonb("capabilities").$type<SpsNodeCapability[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    keyVerifiedAt: timestamp("key_verified_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPublicKeyUniqueIdx: uniqueIndex("sps_nodes_company_public_key_unique_idx").on(
      table.companyId,
      table.publicKey,
    ),
    companyStatusIdx: index("sps_nodes_company_status_idx").on(table.companyId, table.status),
    ownerStatusIdx: index("sps_nodes_owner_status_idx").on(table.ownerUserId, table.status),
  }),
);

export const spsNodeHeartbeats = pgTable(
  "sps_node_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    nonceHash: text("nonce_hash").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nonceUniqueIdx: uniqueIndex("sps_node_heartbeats_nonce_unique_idx").on(table.nonceHash),
    nodeExpiryIdx: index("sps_node_heartbeats_node_expiry_idx").on(table.nodeId, table.expiresAt),
  }),
);

export const spsNodeAgentGrants = pgTable(
  "sps_node_agent_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeAgentUniqueIdx: uniqueIndex("sps_node_agent_grants_node_agent_unique_idx").on(
      table.nodeId,
      table.agentId,
    ),
    companyNodeIdx: index("sps_node_agent_grants_company_node_idx").on(table.companyId, table.nodeId),
    companyAgentIdx: index("sps_node_agent_grants_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

export const spsAgentNodeBindings = pgTable(
  "sps_agent_node_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    assignedByUserId: text("assigned_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentUniqueIdx: uniqueIndex("sps_agent_node_bindings_agent_unique_idx").on(table.agentId),
    companyNodeIdx: index("sps_agent_node_bindings_company_node_idx").on(table.companyId, table.nodeId),
  }),
);

/**
 * A command is created by the Hub and claimed by the SPS Desktop Node that
 * owns the local CLI/runtime. Command rows deliberately contain no provider
 * credentials: those stay in the Desktop Node's local secure storage.
 */
export const spsNodeCommands = pgTable(
  "sps_node_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    cwdHint: text("cwd_hint"),
    env: jsonb("env").$type<Record<string, string>>().notNull().default({}),
    stdin: text("stdin"),
    timeoutMs: integer("timeout_ms"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    timedOut: integer("timed_out").notNull().default(0),
    error: text("error"),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeStatusCreatedIdx: index("sps_node_commands_node_status_created_idx").on(
      table.nodeId,
      table.status,
      table.createdAt,
    ),
    companyAgentCreatedIdx: index("sps_node_commands_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    heartbeatRunIdx: index("sps_node_commands_heartbeat_run_idx").on(table.heartbeatRunId),
  }),
);

export const spsNodeCommandEvents = pgTable(
  "sps_node_command_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    commandId: uuid("command_id").notNull().references(() => spsNodeCommands.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commandSequenceUniqueIdx: uniqueIndex("sps_node_command_events_command_sequence_unique_idx").on(
      table.commandId,
      table.sequence,
    ),
    commandCreatedIdx: index("sps_node_command_events_command_created_idx").on(
      table.commandId,
      table.createdAt,
    ),
  }),
);
