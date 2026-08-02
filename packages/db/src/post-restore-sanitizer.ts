import postgres, { type Sql } from "postgres";

export type PostRestoreSanitizerResult = {
  scrubbedTables: Record<string, number>;
};

type SanitizerExecutor = Pick<Sql, "unsafe">;

// Child rows always precede their parents. Everything in this list is either
// a credential, a machine registration/route, or a disposable execution lease.
const TABLES_TO_DELETE = [
  "session",
  "verification",
  "board_api_keys",
  "agent_api_keys",
  "cli_auth_challenges",
  "join_requests",
  "invites",
  "company_secret_bindings",
  "company_secret_versions",
  "company_secrets",
  "company_secret_provider_configs",
  "secret_access_events",
  "sps_node_command_events",
  "sps_node_commands",
  "sps_plugin_node_run_events",
  "sps_plugin_node_runs",
  "sps_plugin_execution_grants",
  "sps_host_project_share_node_grants",
  "sps_host_project_shares",
  "sps_workspace_source_node_grants",
  "sps_workspace_sources",
  "sps_node_agent_runner_grants",
  "sps_node_agent_grants",
  "sps_agent_node_bindings",
  "sps_node_runner_profiles",
  "sps_node_heartbeats",
  "sps_nodes",
  "environment_leases",
] as const;

type UpdatePlan = {
  table: string;
  assignments: Record<string, string>;
  requiredWhereColumns?: string[];
  where?: string;
};

const UPDATE_PLANS: UpdatePlan[] = [
  {
    table: "cloud_upstream_connections",
    assignments: {
      private_key_pem: "''",
      access_token: "NULL",
      token_id: "NULL",
      token_expires_at: "NULL",
      pending_state: "NULL",
      pending_code_verifier: "NULL",
      pending_redirect_uri: "NULL",
      pending_token_url: "NULL",
      last_run_id: "NULL",
      token_status: "'reauth_required'",
      updated_at: "NOW()",
    },
  },
  {
    table: "cloud_upstream_runs",
    assignments: { status: "'failed'", completed_at: "NOW()", updated_at: "NOW()" },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('pending', 'queued', 'running')`,
  },
  {
    table: "heartbeat_runs",
    assignments: {
      session_id_before: "NULL",
      session_id_after: "NULL",
      process_pid: "NULL",
      process_group_id: "NULL",
      process_started_at: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "heartbeat_runs",
    assignments: {
      status: "'failed'",
      finished_at: "NOW()",
      error: "'SPS Host restore interrupted this run.'",
      error_code: "'host_restored'",
      scheduled_retry_at: "NULL",
      scheduled_retry_reason: "NULL",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('queued', 'running', 'scheduled_retry')`,
  },
  {
    table: "agent_wakeup_requests",
    assignments: {
      status: "'cancelled'",
      finished_at: "NOW()",
      error: "'SPS Host restore cancelled this wakeup.'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('queued', 'deferred_issue_execution', 'claimed')`,
  },
  {
    table: "plugin_job_runs",
    assignments: {
      status: "'cancelled'",
      error: "'SPS Host restore cancelled this plugin job run.'",
      finished_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('pending', 'queued', 'running')`,
  },
  {
    table: "environment_custom_image_setup_sessions",
    assignments: {
      provider_lease_id: "NULL",
      environment_lease_id: "NULL",
      connection_summary: "NULL",
      connection_secret_ref: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "environment_custom_image_setup_sessions",
    assignments: {
      status: "'failed'",
      finished_at: "NOW()",
      failure_reason: "'SPS Host restore interrupted this setup session.'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('starting', 'waiting_for_user', 'capturing')`,
  },
  {
    table: "execution_workspaces",
    assignments: {
      cwd: "NULL",
      provider_ref: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "execution_workspaces",
    assignments: {
      status: "'closed'",
      closed_at: "COALESCE(\"closed_at\", NOW())",
      cleanup_eligible_at: "NULL",
      cleanup_reason: "'SPS Host restored; select a new Host source.'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('queued', 'active', 'running')`,
  },
  {
    table: "workspace_runtime_services",
    assignments: {
      cwd: "NULL",
      provider_ref: "NULL",
      port: "NULL",
      url: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "workspace_runtime_services",
    assignments: {
      status: "'stopped'",
      stopped_at: "COALESCE(\"stopped_at\", NOW())",
      health_status: "'unknown'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('starting', 'active', 'running')`,
  },
  {
    table: "workspace_operations",
    assignments: {
      cwd: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "workspace_operations",
    assignments: {
      status: "'failed'",
      finished_at: "COALESCE(\"finished_at\", NOW())",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('pending', 'queued', 'running')`,
  },
  {
    table: "company_skill_test_runs",
    assignments: {
      status: "'failed'",
      error: "'SPS Host restore interrupted this skill test run.'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('pending', 'queued', 'running')`,
  },
  {
    table: "routine_runs",
    assignments: {
      status: "'failed'",
      failure_reason: "'SPS Host restore interrupted this routine run.'",
      completed_at: "NOW()",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" IN ('received', 'planning', 'pending', 'queued', 'running')`,
  },
  {
    table: "agent_task_sessions",
    assignments: {
      session_params_json: "NULL",
      session_display_id: "NULL",
      updated_at: "NOW()",
    },
  },
  {
    table: "agent_task_sessions",
    assignments: {
      status: "'closed'",
      closed_at: "COALESCE(\"closed_at\", NOW())",
      last_error: "'Provider session reset by SPS Host restore.'",
      updated_at: "NOW()",
    },
    requiredWhereColumns: ["status"],
    where: `"status" = 'active'`,
  },
  {
    table: "agent_runtime_state",
    assignments: {
      session_id: "NULL",
      state_json: "'{}'::jsonb",
      updated_at: "NOW()",
    },
  },
  {
    table: "project_workspaces",
    assignments: {
      cwd: "NULL",
      shared_workspace_key: "NULL",
      updated_at: "NOW()",
    },
  },
];

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe post-restore sanitizer identifier: ${value}`);
  }
  return `"${value}"`;
}

async function tableExists(sql: SanitizerExecutor, tableName: string): Promise<boolean> {
  const rows = await sql.unsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('public.${tableName}') IS NOT NULL AS exists`,
  );
  return rows[0]?.exists === true;
}

async function columnNames(sql: SanitizerExecutor, tableName: string): Promise<Set<string>> {
  const rows = await sql.unsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tableName.replaceAll("'", "''")}'`,
  );
  return new Set(rows.map((row) => row.column_name));
}

function addCount(counts: Record<string, number>, tableName: string, count: number): void {
  counts[tableName] = (counts[tableName] ?? 0) + count;
}

async function applyUpdatePlan(
  sql: SanitizerExecutor,
  plan: UpdatePlan,
  counts: Record<string, number>,
): Promise<void> {
  if (!await tableExists(sql, plan.table)) return;
  const columns = await columnNames(sql, plan.table);
  if (plan.requiredWhereColumns?.some((column) => !columns.has(column))) return;
  const assignments = Object.entries(plan.assignments)
    .filter(([column]) => columns.has(column))
    .map(([column, value]) => `${quoteIdentifier(column)} = ${value}`);
  if (assignments.length === 0) return;
  const result = await sql.unsafe(
    `UPDATE ${quoteIdentifier(plan.table)} SET ${assignments.join(", ")}${plan.where ? ` WHERE ${plan.where}` : ""}`,
  );
  addCount(counts, plan.table, result.count);
}

/**
 * Removes machine-bound credentials and resets in-flight runtime state after
 * a Host backup is restored. Durable users, memberships, workspaces, tasks,
 * comments, chat messages, plugin state, and execution history are retained.
 */
export async function sanitizePostRestoreDatabase(
  connectionString: string,
): Promise<PostRestoreSanitizerResult> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    return await sanitizePostRestoreDatabaseWithExecutor(sql);
  } finally {
    await sql.end();
  }
}

export async function sanitizePostRestoreDatabaseWithExecutor(
  sql: SanitizerExecutor,
): Promise<PostRestoreSanitizerResult> {
  const scrubbedTables: Record<string, number> = {};
  await sql.unsafe("BEGIN");
  try {
    if (await tableExists(sql, "account")) {
      const accountColumns = await columnNames(sql, "account");
      const sensitiveAccountColumns = [
        "access_token",
        "refresh_token",
        "id_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "password",
      ].filter((column) => accountColumns.has(column));
      if (sensitiveAccountColumns.length > 0) {
        const result = await sql.unsafe(
          `UPDATE "account" SET ${sensitiveAccountColumns.map((column) => `${quoteIdentifier(column)} = NULL`).join(", ")}`,
        );
        addCount(scrubbedTables, "account", result.count);
      }
    }

    for (const plan of UPDATE_PLANS) {
      await applyUpdatePlan(sql, plan, scrubbedTables);
    }

    for (const tableName of TABLES_TO_DELETE) {
      if (!await tableExists(sql, tableName)) continue;
      const result = await sql.unsafe(`DELETE FROM ${quoteIdentifier(tableName)}`);
      addCount(scrubbedTables, tableName, result.count);
    }

    await sql.unsafe("COMMIT");
    return { scrubbedTables };
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Preserve the original database error.
    }
    throw error;
  }
}
