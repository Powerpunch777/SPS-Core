import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginLifecycleProposalEvents, pluginLifecycleProposals } from "@paperclipai/db";
import type {
  CreatePluginLifecycleProposal,
  PluginLifecycleProposalRecord,
  PluginLifecycleProposalRiskSummary,
  PluginLifecycleProposalStatus,
} from "@paperclipai/shared";

export interface PluginLifecycleProposalActor {
  actorType: "plugin" | "user" | "system";
  actorId: string;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface PluginLifecycleProposalRiskInput {
  riskSummary: PluginLifecycleProposalRiskSummary;
}

function toRecord(row: typeof pluginLifecycleProposals.$inferSelect): PluginLifecycleProposalRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    operation: row.operation,
    status: row.status,
    target: row.targetJson,
    rationale: row.rationale,
    authoringSessionId: row.authoringSessionId,
    evidenceRefs: row.evidenceRefs,
    riskSummary: row.riskSummary,
    createdByPluginId: row.createdByPluginId,
    createdByAgentId: row.createdByAgentId,
    decisionByUserId: row.decisionByUserId,
    decisionReason: row.decisionReason,
    executedAt: row.executedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Persistence boundary for non-mutating plugin lifecycle intent. Execution is
 * intentionally owned by the authenticated Host routes, never by a worker.
 */
export function createPluginLifecycleProposalService(db: Db) {
  async function appendEvent(input: {
    proposalId: string;
    companyId: string;
    eventType: string;
    actor: PluginLifecycleProposalActor;
    details?: Record<string, unknown>;
  }) {
    await db.insert(pluginLifecycleProposalEvents).values({
      proposalId: input.proposalId,
      companyId: input.companyId,
      eventType: input.eventType,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      details: input.details ?? {},
    });
  }

  return {
    async create(input: CreatePluginLifecycleProposal & { companyId: string }, actor: PluginLifecycleProposalActor, risk: PluginLifecycleProposalRiskInput) {
      const [row] = await db.insert(pluginLifecycleProposals).values({
        companyId: input.companyId,
        operation: input.operation,
        targetJson: {
          ...input.target,
          pluginId: input.target.pluginId ?? null,
          packageName: input.target.packageName ?? null,
          version: input.target.version ?? null,
          registryStageId: input.target.registryStageId ?? null,
        },
        rationale: input.rationale,
        authoringSessionId: input.authoringSessionId,
        evidenceRefs: input.evidenceRefs,
        riskSummary: risk.riskSummary,
        createdByPluginId: actor.pluginId ?? null,
        createdByAgentId: actor.agentId ?? null,
      }).returning();
      if (!row) throw new Error("Failed to create plugin lifecycle proposal");
      await appendEvent({ proposalId: row.id, companyId: row.companyId, eventType: "created", actor, details: { operation: row.operation, target: row.targetJson } });
      return toRecord(row);
    },

    async get(companyId: string, proposalId: string) {
      const [row] = await db.select().from(pluginLifecycleProposals)
        .where(and(eq(pluginLifecycleProposals.companyId, companyId), eq(pluginLifecycleProposals.id, proposalId)));
      return row ? toRecord(row) : null;
    },

    async list(companyId: string, status?: PluginLifecycleProposalStatus) {
      const rows = await db.select().from(pluginLifecycleProposals)
        .where(status
          ? and(eq(pluginLifecycleProposals.companyId, companyId), eq(pluginLifecycleProposals.status, status))
          : eq(pluginLifecycleProposals.companyId, companyId))
        .orderBy(desc(pluginLifecycleProposals.createdAt));
      return rows.map(toRecord);
    },

    async decide(input: {
      companyId: string;
      proposalId: string;
      status: Exclude<PluginLifecycleProposalStatus, "pending">;
      actor: PluginLifecycleProposalActor;
      userId?: string | null;
      reason?: string | null;
      executed?: boolean;
      details?: Record<string, unknown>;
    }) {
      const existing = await this.get(input.companyId, input.proposalId);
      if (!existing) return null;
      if (existing.status !== "pending") return { conflict: existing };
      const now = new Date();
      const [row] = await db.update(pluginLifecycleProposals)
        .set({
          status: input.status,
          decisionByUserId: input.userId ?? null,
          decisionReason: input.reason ?? null,
          executedAt: input.executed ? now : null,
          updatedAt: now,
        })
        .where(and(
          eq(pluginLifecycleProposals.id, input.proposalId),
          eq(pluginLifecycleProposals.companyId, input.companyId),
          eq(pluginLifecycleProposals.status, "pending"),
        ))
        .returning();
      if (!row) return { conflict: await this.get(input.companyId, input.proposalId) };
      await appendEvent({
        proposalId: row.id,
        companyId: row.companyId,
        eventType: input.status,
        actor: input.actor,
        details: input.details,
      });
      return { proposal: toRecord(row) };
    },

    async listEvents(companyId: string, proposalId: string) {
      return db.select({
        id: pluginLifecycleProposalEvents.id,
        eventType: pluginLifecycleProposalEvents.eventType,
        actorType: pluginLifecycleProposalEvents.actorType,
        actorId: pluginLifecycleProposalEvents.actorId,
        details: pluginLifecycleProposalEvents.details,
        createdAt: pluginLifecycleProposalEvents.createdAt,
      }).from(pluginLifecycleProposalEvents)
        .where(and(eq(pluginLifecycleProposalEvents.companyId, companyId), eq(pluginLifecycleProposalEvents.proposalId, proposalId)))
        .orderBy(pluginLifecycleProposalEvents.createdAt);
    },
  };
}
