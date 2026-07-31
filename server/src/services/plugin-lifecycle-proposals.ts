import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginLifecycleProposalEvents, pluginLifecycleProposals } from "@paperclipai/db";
import type {
  CreatePluginLifecycleProposal,
  PluginLifecycleProposalRecord,
  PluginLifecycleProposalRiskSummary,
  PluginLifecycleProposalStatus,
} from "@paperclipai/shared";
import { createPluginLifecycleProposalSchema } from "@paperclipai/shared";

export interface PluginLifecycleProposalActor {
  actorType: "plugin" | "agent" | "user" | "system";
  actorId: string;
  pluginId?: string | null;
  agentId?: string | null;
}

export interface PluginLifecycleProposalRiskInput {
  riskSummary: PluginLifecycleProposalRiskSummary;
}

type DbWriter = Pick<Db, "insert">;

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
  async function appendEvent(writer: DbWriter, input: {
    proposalId: string;
    companyId: string;
    eventType: string;
    actor: PluginLifecycleProposalActor;
    details?: Record<string, unknown>;
  }) {
    await writer.insert(pluginLifecycleProposalEvents).values({
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
      const parsed = createPluginLifecycleProposalSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid plugin lifecycle proposal");
      const proposalInput = parsed.data;
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(pluginLifecycleProposals).values({
          companyId: input.companyId,
          operation: proposalInput.operation,
          targetJson: {
            ...proposalInput.target,
            pluginId: proposalInput.target.pluginId ?? null,
            packageName: proposalInput.target.packageName ?? null,
            version: proposalInput.target.version ?? null,
            registryStageId: proposalInput.target.registryStageId ?? null,
          },
          rationale: proposalInput.rationale,
          authoringSessionId: proposalInput.authoringSessionId,
          evidenceRefs: proposalInput.evidenceRefs,
          riskSummary: risk.riskSummary,
          createdByPluginId: actor.pluginId ?? null,
          createdByAgentId: actor.agentId ?? null,
        }).returning();
        if (!row) throw new Error("Failed to create plugin lifecycle proposal");
        await appendEvent(tx, { proposalId: row.id, companyId: row.companyId, eventType: "created", actor, details: { operation: row.operation, target: row.targetJson } });
        return toRecord(row);
      });
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
      const expectedStatus = input.status === "rejected" ? "pending" : "executing";
      const existing = await this.get(input.companyId, input.proposalId);
      if (!existing) return null;
      if (existing.status !== expectedStatus) return { conflict: existing };
      return db.transaction(async (tx) => {
        const now = new Date();
        const [row] = await tx.update(pluginLifecycleProposals)
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
            eq(pluginLifecycleProposals.status, expectedStatus),
          ))
          .returning();
        if (!row) return { conflict: await this.get(input.companyId, input.proposalId) };
        await appendEvent(tx, {
          proposalId: row.id,
          companyId: row.companyId,
          eventType: input.status,
          actor: input.actor,
          details: input.details,
        });
        return { proposal: toRecord(row) };
      });
    },

    async beginDecision(input: {
      companyId: string;
      proposalId: string;
      actor: PluginLifecycleProposalActor;
      userId: string;
    }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(pluginLifecycleProposals)
          .set({ status: "executing", decisionByUserId: input.userId, updatedAt: new Date() })
          .where(and(
            eq(pluginLifecycleProposals.id, input.proposalId),
            eq(pluginLifecycleProposals.companyId, input.companyId),
            eq(pluginLifecycleProposals.status, "pending"),
          ))
          .returning();
        if (!row) return { conflict: await this.get(input.companyId, input.proposalId) };
        await appendEvent(tx, {
          proposalId: row.id,
          companyId: row.companyId,
          eventType: "executing",
          actor: input.actor,
          details: { reason: "Host decision claimed for execution" },
        });
        return { proposal: toRecord(row) };
      });
    },

    async releaseDecision(input: {
      companyId: string;
      proposalId: string;
      actor: PluginLifecycleProposalActor;
      reason: string;
    }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.update(pluginLifecycleProposals)
          .set({ status: "pending", decisionReason: input.reason, updatedAt: new Date() })
          .where(and(
            eq(pluginLifecycleProposals.id, input.proposalId),
            eq(pluginLifecycleProposals.companyId, input.companyId),
            eq(pluginLifecycleProposals.status, "executing"),
          ))
          .returning();
        if (!row) return { conflict: await this.get(input.companyId, input.proposalId) };
        await appendEvent(tx, {
          proposalId: row.id,
          companyId: row.companyId,
          eventType: "decision_released",
          actor: input.actor,
          details: { reason: input.reason },
        });
        return { proposal: toRecord(row) };
      });
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
