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

/**
 * A public, safe-to-share summary of a runtime account on an SPS Node. This
 * deliberately never contains a token, API key, cookie, home directory, or
 * provider account identifier.
 */
export type SpsNodeRunnerAvailabilityStatus =
  | "available"
  | "busy"
  | "quota_limited"
  | "auth_required"
  | "offline"
  | "unknown";

export type SpsNodeRunnerCredentialStatus = "ready" | "auth_required" | "unknown";

export type SpsNodeRunnerAvailabilitySource = "node_probe" | "adapter" | "manual";

export type SpsNodeRunnerProfile = {
  runnerKey: string;
  kind: SpsNodeCapability["kind"];
  label: string;
  version?: string | null;
  models?: string[];
  profileLabel?: string | null;
  credentialStatus?: SpsNodeRunnerCredentialStatus;
  availability?: {
    status: SpsNodeRunnerAvailabilityStatus;
    observedAt: string;
    source: SpsNodeRunnerAvailabilitySource;
    confidence?: number | null;
    retryAfter?: string | null;
    detail?: string | null;
  };
};

export const spsNodes = pgTable(
  "sps_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: text("display_name").notNull(),
    publicKey: text("public_key").notNull(),
    transportPublicKey: text("transport_public_key"),
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

/**
 * A runner is the Node-local execution profile an Agent can be allowed to use.
 * Secrets remain in the Node's OS-backed storage; the Hub retains only this
 * operational metadata and the most recently reported availability snapshot.
 */
export const spsNodeRunnerProfiles = pgTable(
  "sps_node_runner_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    runnerKey: text("runner_key").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    version: text("version"),
    models: jsonb("models").$type<string[]>().notNull().default([]),
    profileLabel: text("profile_label"),
    credentialStatus: text("credential_status").notNull().default("unknown"),
    availabilityStatus: text("availability_status").notNull().default("unknown"),
    availabilityDetail: text("availability_detail"),
    availabilitySource: text("availability_source").notNull().default("node_probe"),
    availabilityConfidence: integer("availability_confidence"),
    availabilityObservedAt: timestamp("availability_observed_at", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeRunnerKeyUniqueIdx: uniqueIndex("sps_node_runner_profiles_node_runner_key_unique_idx").on(
      table.nodeId,
      table.runnerKey,
    ),
    companyNodeIdx: index("sps_node_runner_profiles_company_node_idx").on(table.companyId, table.nodeId),
    nodeAvailabilityIdx: index("sps_node_runner_profiles_node_availability_idx").on(
      table.nodeId,
      table.availabilityStatus,
    ),
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

/**
 * An execution grant beneath a Node-level Agent grant. Once a Node advertises
 * Runner Profiles, an Agent must have this exact grant for the selected local
 * profile. Node-level grants remain the coarse machine boundary and preserve
 * compatibility for commands created before Runner Profiles existed.
 */
export const spsNodeAgentRunnerGrants = pgTable(
  "sps_node_agent_runner_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    runnerProfileId: uuid("runner_profile_id")
      .notNull()
      .references(() => spsNodeRunnerProfiles.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeRunnerAgentUniqueIdx: uniqueIndex("sps_node_agent_runner_grants_node_runner_agent_unique_idx").on(
      table.nodeId,
      table.runnerProfileId,
      table.agentId,
    ),
    companyNodeAgentIdx: index("sps_node_agent_runner_grants_company_node_agent_idx").on(
      table.companyId,
      table.nodeId,
      table.agentId,
    ),
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
 * A Host-owned source folder made available to approved Member Nodes. The Hub
 * records only the network share identity; the Host's local source path and
 * the plaintext share credentials never leave their respective computers.
 */
export const spsHostProjectShares = pgTable(
  "sps_host_project_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    // The physical Owner Host may execute work through Core directly and is
    // not required to register itself as a remote Node. Keep this optional for
    // a future Host Runner binding without making source sharing depend on it.
    hostNodeId: uuid("host_node_id").references(() => spsNodes.id, { onDelete: "set null" }),
    sharePath: text("share_path").notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectUniqueIdx: uniqueIndex("sps_host_project_shares_company_project_unique_idx").on(
      table.companyId,
      table.projectId,
    ),
    hostNodeIdx: index("sps_host_project_shares_host_node_idx").on(table.hostNodeId),
  }),
);

/**
 * The credential envelope is encrypted to the target Node's transport public
 * key. The Hub can route it but cannot decrypt it, and it is never added to a
 * CLI environment or task transcript.
 */
export const spsHostProjectShareNodeGrants = pgTable(
  "sps_host_project_share_node_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    shareId: uuid("share_id").notNull().references(() => spsHostProjectShares.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    credentialAlgorithm: text("credential_algorithm").notNull().default("rsa-oaep-sha256"),
    credentialEnvelope: text("credential_envelope").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    shareNodeUniqueIdx: uniqueIndex("sps_host_project_share_node_grants_share_node_unique_idx").on(
      table.shareId,
      table.nodeId,
    ),
    companyNodeIdx: index("sps_host_project_share_node_grants_company_node_idx").on(
      table.companyId,
      table.nodeId,
    ),
  }),
);

/**
 * A command is created by the Hub and claimed by the SPS Desktop Node that
 * owns the local CLI/runtime. Command rows deliberately contain no provider
 * credentials: those stay in the Desktop Node's local secure storage. A
 * project share access envelope is an exception only in form: it is encrypted
 * to the target Node and cannot be read by the Hub or passed to the CLI.
 */
export const spsNodeCommands = pgTable(
  "sps_node_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    workspaceExecutionEpoch: text("workspace_execution_epoch").notNull().default("0"),
    runnerProfileId: uuid("runner_profile_id").references(() => spsNodeRunnerProfiles.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    cwdHint: text("cwd_hint"),
    workspaceAccess: jsonb("workspace_access").$type<Record<string, unknown> | null>(),
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
    completionReceiptDigest: text("completion_receipt_digest"),
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
    runnerCreatedIdx: index("sps_node_commands_runner_created_idx").on(table.runnerProfileId, table.createdAt),
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
