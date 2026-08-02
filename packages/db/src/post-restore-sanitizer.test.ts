import { describe, expect, it, vi } from "vitest";
import { sanitizePostRestoreDatabaseWithExecutor } from "./post-restore-sanitizer.js";

type SanitizerExecutor = Parameters<typeof sanitizePostRestoreDatabaseWithExecutor>[0];

const DEFAULT_COLUMNS: Record<string, string[]> = {
  account: ["access_token", "refresh_token", "id_token", "access_token_expires_at", "refresh_token_expires_at", "password"],
  cloud_upstream_connections: ["private_key_pem", "access_token", "token_id", "token_expires_at", "pending_state", "pending_code_verifier", "pending_redirect_uri", "pending_token_url", "last_run_id", "token_status", "updated_at"],
  heartbeat_runs: ["status", "finished_at", "error", "error_code", "session_id_before", "session_id_after", "process_pid", "process_group_id", "process_started_at", "scheduled_retry_at", "scheduled_retry_reason", "updated_at"],
  agent_wakeup_requests: ["status", "finished_at", "error", "updated_at"],
  plugin_job_runs: ["status", "error", "finished_at"],
  agent_task_sessions: ["session_params_json", "session_display_id", "status", "closed_at", "last_error", "updated_at"],
  agent_runtime_state: ["session_id", "state_json", "last_error", "updated_at"],
  project_workspaces: ["cwd", "remote_workspace_ref", "shared_workspace_key", "updated_at"],
};

function fakeExecutor(options: {
  tables?: string[];
  columnsByTable?: Record<string, string[]>;
  failOn?: string;
} = {}) {
  const calls: string[] = [];
  const tables = new Set(options.tables ?? ["account", "session"]);
  const columnsByTable = { ...DEFAULT_COLUMNS, ...options.columnsByTable };
  const unsafe = vi.fn(async (query: string) => {
    calls.push(query);
    if (options.failOn && query.includes(options.failOn)) throw new Error("sanitizer failure");
    if (query === "BEGIN" || query === "COMMIT" || query === "ROLLBACK") return { count: 0 };
    if (query.includes("information_schema.columns")) {
      const tableName = query.match(/table_name = '([^']+)'/)?.[1] ?? "";
      return (columnsByTable[tableName] ?? []).map((column_name) => ({ column_name }));
    }
    if (query.includes("to_regclass")) {
      const tableName = query.match(/public\.([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      return [{ exists: tableName ? tables.has(tableName) : false }];
    }
    return { count: 1 };
  });
  return { unsafe, calls };
}

function run(executor: ReturnType<typeof fakeExecutor>) {
  return sanitizePostRestoreDatabaseWithExecutor(executor as unknown as SanitizerExecutor);
}

describe("sanitizePostRestoreDatabaseWithExecutor", () => {
  it("deletes FK children before parents", async () => {
    const executor = fakeExecutor({
      tables: [
        "join_requests",
        "invites",
        "sps_node_command_events",
        "sps_node_commands",
        "sps_node_runner_profiles",
        "sps_nodes",
      ],
    });

    await run(executor);

    expect(executor.calls.indexOf('DELETE FROM "join_requests"')).toBeLessThan(
      executor.calls.indexOf('DELETE FROM "invites"'),
    );
    expect(executor.calls.indexOf('DELETE FROM "sps_node_command_events"')).toBeLessThan(
      executor.calls.indexOf('DELETE FROM "sps_node_commands"'),
    );
    expect(executor.calls.indexOf('DELETE FROM "sps_node_commands"')).toBeLessThan(
      executor.calls.indexOf('DELETE FROM "sps_nodes"'),
    );
    expect(executor.calls.indexOf('DELETE FROM "sps_node_runner_profiles"')).toBeLessThan(
      executor.calls.indexOf('DELETE FROM "sps_nodes"'),
    );
  });

  it("preserves history tables and closes their active rows", async () => {
    const mutableHistory = [
      "heartbeat_runs",
      "agent_wakeup_requests",
      "plugin_job_runs",
      "agent_task_sessions",
      "agent_runtime_state",
    ];
    const immutableHistory = [
      "heartbeat_run_events",
      "heartbeat_run_watchdog_decisions",
      "activity_log",
      "cost_events",
      "finance_events",
      "sps_marketplace_assistant_messages",
    ];
    const executor = fakeExecutor({ tables: [...mutableHistory, ...immutableHistory] });

    await run(executor);

    for (const table of [...mutableHistory, ...immutableHistory]) {
      expect(executor.calls).not.toContain(`DELETE FROM "${table}"`);
    }
    for (const table of mutableHistory) {
      expect(executor.calls.some((query) => query.startsWith(`UPDATE "${table}" SET`))).toBe(true);
    }
    expect(executor.calls.find((query) =>
      query.startsWith('UPDATE "heartbeat_runs" SET') && query.includes(" WHERE "),
    )).toContain(
      `WHERE "status" IN ('queued', 'running', 'scheduled_retry')`,
    );
    expect(executor.calls.find((query) => query.startsWith('UPDATE "plugin_job_runs" SET'))).toContain(
      `"status" = 'cancelled'`,
    );
  });

  it("clears provider sessions, credentials, and machine-bound workspace routes", async () => {
    const executor = fakeExecutor({
      tables: [
        "account",
        "cloud_upstream_connections",
        "agent_task_sessions",
        "agent_runtime_state",
        "project_workspaces",
      ],
    });

    await run(executor);

    expect(executor.calls.find((query) => query.startsWith('UPDATE "account" SET'))).toContain(
      '"refresh_token" = NULL',
    );
    expect(executor.calls.find((query) => query.startsWith('UPDATE "cloud_upstream_connections" SET'))).toContain(
      '"private_key_pem" = \'\'',
    );
    expect(executor.calls.find((query) => query.startsWith('UPDATE "agent_task_sessions" SET'))).toContain(
      '"session_params_json" = NULL',
    );
    expect(executor.calls.find((query) => query.startsWith('UPDATE "agent_runtime_state" SET'))).toContain(
      '"state_json" = \'{}\'::jsonb',
    );
    expect(executor.calls.find((query) => query.startsWith('UPDATE "project_workspaces" SET'))).toContain(
      '"cwd" = NULL',
    );
  });

  it("tolerates old backups with absent tables and columns", async () => {
    const executor = fakeExecutor({
      tables: ["account", "heartbeat_runs"],
      columnsByTable: { account: ["provider_id"], heartbeat_runs: ["created_at"] },
    });

    await expect(run(executor)).resolves.toEqual({ scrubbedTables: {} });
    expect(executor.calls.at(-1)).toBe("COMMIT");
  });

  it("rolls back atomically when a scrub operation fails", async () => {
    const executor = fakeExecutor({ tables: ["session"], failOn: 'DELETE FROM "session"' });

    await expect(run(executor)).rejects.toThrow("sanitizer failure");
    expect(executor.calls.at(-1)).toBe("ROLLBACK");
    expect(executor.calls).not.toContain("COMMIT");
  });

  it("is safe to run repeatedly", async () => {
    const executor = fakeExecutor({ tables: ["session", "heartbeat_runs"] });

    await run(executor);
    await run(executor);

    expect(executor.calls.filter((query) => query === "BEGIN")).toHaveLength(2);
    expect(executor.calls.filter((query) => query === "COMMIT")).toHaveLength(2);
  });
});
