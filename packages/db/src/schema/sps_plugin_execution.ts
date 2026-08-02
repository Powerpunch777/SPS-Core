import {
  bigserial,
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
import { spsNodes, spsNodeRunnerProfiles } from "./sps_nodes.js";
import { spsWorkspaceSources } from "./sps_workspace_sources.js";

/**
 * A workflow-neutral technical execution allowance. The plugin owns the
 * meaning of `subjectKey` (for example, a worker, run, or automation), while
 * SPS Core only verifies that the selected Node, local Runner, and optional
 * Host Workspace Source remain available.
 */
export const spsPluginExecutionGrants = pgTable(
  "sps_plugin_execution_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    runnerProfileId: uuid("runner_profile_id")
      .notNull()
      .references(() => spsNodeRunnerProfiles.id, { onDelete: "cascade" }),
    workspaceSourceId: uuid("workspace_source_id")
      .references(() => spsWorkspaceSources.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginSubjectNodeRunnerSourceUniqueIdx: uniqueIndex("sps_plugin_execution_grants_plugin_subject_target_unique_idx").on(
      table.companyId,
      table.pluginKey,
      table.subjectKey,
      table.nodeId,
      table.runnerProfileId,
      table.workspaceSourceId,
    ),
    companyPluginSubjectIdx: index("sps_plugin_execution_grants_company_plugin_subject_idx").on(
      table.companyId,
      table.pluginKey,
      table.subjectKey,
    ),
    nodeStatusIdx: index("sps_plugin_execution_grants_node_status_idx").on(table.nodeId, table.status),
  }),
);

/**
 * A command queued by a plugin through its explicit execution grant. This is
 * intentionally separate from `sps_node_commands`, which remains the legacy
 * Paperclip Agent execution lane.
 */
export const spsPluginNodeRuns = pgTable(
  "sps_plugin_node_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    executionGrantId: uuid("execution_grant_id")
      .notNull()
      .references(() => spsPluginExecutionGrants.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => spsNodes.id, { onDelete: "cascade" }),
    runnerProfileId: uuid("runner_profile_id")
      .notNull()
      .references(() => spsNodeRunnerProfiles.id, { onDelete: "restrict" }),
    workspaceSourceId: uuid("workspace_source_id")
      .references(() => spsWorkspaceSources.id, { onDelete: "set null" }),
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
    nodeStatusCreatedIdx: index("sps_plugin_node_runs_node_status_created_idx").on(
      table.nodeId,
      table.status,
      table.createdAt,
    ),
    companyPluginSubjectCreatedIdx: index("sps_plugin_node_runs_company_plugin_subject_created_idx").on(
      table.companyId,
      table.pluginKey,
      table.subjectKey,
      table.createdAt,
    ),
    executionGrantIdx: index("sps_plugin_node_runs_execution_grant_idx").on(table.executionGrantId),
  }),
);

export const spsPluginNodeRunEvents = pgTable(
  "sps_plugin_node_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull().references(() => spsPluginNodeRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSequenceUniqueIdx: uniqueIndex("sps_plugin_node_run_events_run_sequence_unique_idx").on(
      table.runId,
      table.sequence,
    ),
    runCreatedIdx: index("sps_plugin_node_run_events_run_created_idx").on(table.runId, table.createdAt),
  }),
);

/**
 * A plugin-published work-product record. Core stores only safe descriptive
 * metadata and an optional validated external reference; Host-local paths and
 * Node credentials are never represented here.
 */
export const spsPluginArtifacts = pgTable(
  "sps_plugin_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    runId: uuid("run_id").references(() => spsPluginNodeRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("reference"),
    referenceUrl: text("reference_url"),
    summary: text("summary"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPluginSubjectCreatedIdx: index("sps_plugin_artifacts_company_plugin_subject_created_idx").on(
      table.companyId,
      table.pluginKey,
      table.subjectKey,
      table.createdAt,
    ),
    runIdx: index("sps_plugin_artifacts_run_idx").on(table.runId),
  }),
);
