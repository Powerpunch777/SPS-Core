import { and, desc, eq, isNull } from "drizzle-orm";
import {
  agents,
  pluginToolAuditEvents,
  pluginToolGrants,
  type Db,
} from "@paperclipai/db";
import type { PluginRecord } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export interface PluginToolGrantSummary {
  id: string;
  agentId: string;
  grantedByUserId: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginToolAuditSummary {
  id: string;
  agentId: string;
  runId: string | null;
  projectId: string | null;
  toolName: string;
  status: "succeeded" | "failed" | "denied";
  /** Stable metadata code only. Raw plugin errors and tool payloads are never stored. */
  error: PluginToolAuditErrorCode | null;
  createdAt: string;
}

export type PluginToolAuditErrorCode =
  | "MEMORY_PROVIDER_NOT_SELECTED"
  | "EXPLICIT_GRANT_REQUIRED"
  | "PLUGIN_TOOL_EXECUTION_FAILED";

export function pluginRequiresExplicitToolGrant(plugin: Pick<PluginRecord, "manifestJson">): boolean {
  // Installed records from older SPS builds can lack a parsed manifest until
  // their next lifecycle refresh. They keep the historic company-default
  // behavior instead of turning an otherwise valid tool call into a 500.
  return plugin.manifestJson?.agentToolAccess === "explicit_grant";
}

/**
 * Core-level authorization and payload-free audit for privileged plugin tools.
 * A plugin opts in through its manifest, so this remains generic and works for
 * remote MCP connectors, local MCP bridges, and future specialist tools.
 */
export function createPluginToolAccessService(db: Db) {
  const log = logger.child({ service: "plugin-tool-access" });

  return {
    async isAllowed(input: { companyId: string; plugin: PluginRecord; agentId: string }): Promise<boolean> {
      if (!pluginRequiresExplicitToolGrant(input.plugin)) return true;
      const rows = await db
        .select({ id: pluginToolGrants.id })
        .from(pluginToolGrants)
        .where(and(
          eq(pluginToolGrants.companyId, input.companyId),
          eq(pluginToolGrants.pluginId, input.plugin.id),
          eq(pluginToolGrants.agentId, input.agentId),
          isNull(pluginToolGrants.revokedAt),
        ))
        .limit(1);
      return rows.length > 0;
    },

    async setGrant(input: {
      companyId: string;
      pluginId: string;
      agentId: string;
      grantedByUserId: string;
      enabled: boolean;
    }): Promise<PluginToolGrantSummary> {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!agent) throw new Error("Agent does not belong to this company.");

      const now = new Date();
      const row = await db
        .insert(pluginToolGrants)
        .values({
          companyId: input.companyId,
          pluginId: input.pluginId,
          agentId: input.agentId,
          grantedByUserId: input.grantedByUserId,
          revokedAt: input.enabled ? null : now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [pluginToolGrants.pluginId, pluginToolGrants.agentId],
          set: {
            companyId: input.companyId,
            grantedByUserId: input.grantedByUserId,
            revokedAt: input.enabled ? null : now,
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0]!);
      return {
        id: row.id,
        agentId: row.agentId,
        grantedByUserId: row.grantedByUserId,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    async listGrants(companyId: string, pluginId: string): Promise<PluginToolGrantSummary[]> {
      const rows = await db
        .select()
        .from(pluginToolGrants)
        .where(and(eq(pluginToolGrants.companyId, companyId), eq(pluginToolGrants.pluginId, pluginId)))
        .orderBy(desc(pluginToolGrants.updatedAt));
      return rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        grantedByUserId: row.grantedByUserId,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async record(input: {
      companyId: string;
      pluginId: string;
      agentId: string;
      runId: string | null;
      projectId: string | null;
      toolName: string;
      status: PluginToolAuditSummary["status"];
      errorCode?: PluginToolAuditErrorCode | null;
    }): Promise<void> {
      try {
        await db.insert(pluginToolAuditEvents).values({
          companyId: input.companyId,
          pluginId: input.pluginId,
          agentId: input.agentId,
          runId: input.runId,
          projectId: input.projectId,
          toolName: input.toolName,
          status: input.status,
          error: input.errorCode ?? null,
        });
      } catch (error) {
        log.warn({ pluginId: input.pluginId, toolName: input.toolName, err: error }, "plugin tool audit write failed");
      }
    },

    async listAudit(input: { companyId: string; pluginId: string; limit?: number }): Promise<PluginToolAuditSummary[]> {
      const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
      const rows = await db
        .select()
        .from(pluginToolAuditEvents)
        .where(and(
          eq(pluginToolAuditEvents.companyId, input.companyId),
          eq(pluginToolAuditEvents.pluginId, input.pluginId),
        ))
        .orderBy(desc(pluginToolAuditEvents.createdAt))
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        agentId: row.agentId,
        runId: row.runId,
        projectId: row.projectId,
        toolName: row.toolName,
        status: row.status as PluginToolAuditSummary["status"],
        error: row.error as PluginToolAuditErrorCode | null,
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}
