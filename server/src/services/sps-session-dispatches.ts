import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentTaskSessions, agentWakeupRequests, companies, heartbeatRuns, spsSessionDispatches, type Db } from "../compat/paperclip/db.js";
import { lockSpsWorkspaceExecutionControl } from "./sps-workspace-execution-control.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type Scope = { companyId: string; sessionId: string; requestId: string };
type Send = Scope & { prompt: string; reason?: string };
type Receipt = { requestId: string; state: "pending" | "submitted" | "uncertain"; runId: string | null };
const unavailable = () => new Error("Session request is unavailable or unresolved; query the same request before taking further action");

export function validateSessionDispatch(input: Send) {
  if (![input.companyId, input.sessionId, input.requestId].every(value => typeof value === "string" && uuid.test(value))
    || typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt, "utf8") > 48 * 1024
    || /[\u0000\ufffd]/u.test(input.prompt)
    || input.reason !== undefined && (typeof input.reason !== "string" || Buffer.byteLength(input.reason, "utf8") > 1_024
      || /[\u0000-\u001f\u007f\ufffd]/u.test(input.reason))) throw unavailable();
  return createHash("sha256").update(JSON.stringify([input.sessionId, input.prompt, input.reason ?? null])).digest("hex");
}

// A durable at-most-once admission receipt, not an exactly-once provider promise.
// A crash between reservation and wakeup stays unresolved and is never replayed.
export function spsSessionDispatchService(db: Db, pluginId: string, pluginKey: string,
  assertCurrent: (companyId: string) => Promise<void>) {
  const conditions = (input: Scope) => and(eq(spsSessionDispatches.companyId, input.companyId),
    eq(spsSessionDispatches.pluginId, pluginId), eq(spsSessionDispatches.requestId, input.requestId));
  const wakeKey = (input: Scope) => `sps-session:${pluginId}:${input.requestId}`;
  const dto = (row: typeof spsSessionDispatches.$inferSelect): Receipt => {
    if (!["pending", "submitted", "uncertain"].includes(row.state)
      || row.state === "submitted" && !row.runId || row.state !== "submitted" && row.runId !== null) throw unavailable();
    return { requestId: row.requestId, state: row.state as Receipt["state"], runId: row.runId };
  };
  async function owned(input: Scope) {
    await assertCurrent(input.companyId);
    if (![input.companyId, input.sessionId, input.requestId].every(value => typeof value === "string" && uuid.test(value))) throw unavailable();
    const row = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id, input.sessionId),
      eq(agentTaskSessions.companyId, input.companyId))).then(rows => rows[0]);
    await assertCurrent(input.companyId);
    if (!row || row.userId !== null || !row.taskKey.startsWith(`plugin:${pluginKey}:session:`)) throw unavailable();
    return row;
  }
  async function getRequest(input: Scope): Promise<Receipt | null> {
    const session = await owned(input);
    let row = await db.select().from(spsSessionDispatches).where(conditions(input)).then(rows => rows[0]);
    await assertCurrent(input.companyId);
    if (!row) return null;
    if (row.sessionId !== input.sessionId) throw unavailable();
    if (row.state !== "submitted") {
      // The scheduler's atomic wakeup/run transaction can recover a lost reply.
      const wakes = await db.select({ runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, session.agentId),
        eq(agentWakeupRequests.idempotencyKey, wakeKey(input)), eq(agentWakeupRequests.requestedByActorId, pluginId),
      )).limit(2);
      await assertCurrent(input.companyId);
      if (wakes.length > 1) throw unavailable();
      if (wakes[0]?.runId) {
        const run = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, wakes[0].runId),
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, session.agentId))).then(rows => rows[0]);
        const conversation = run?.contextSnapshot?.spsPluginConversation as Record<string, unknown> | undefined;
        await assertCurrent(input.companyId);
        if (!run || run.contextSnapshot?.taskKey !== session.taskKey || conversation?.pluginKey !== pluginKey
          || conversation.sessionId !== input.sessionId || conversation.requestId !== input.requestId) throw unavailable();
        const updated = await db.update(spsSessionDispatches).set({ state: "submitted", runId: run.id, updatedAt: new Date() })
          .where(and(conditions(input), inArray(spsSessionDispatches.state, ["pending", "uncertain"]))).returning();
        row = updated[0] ?? await db.select().from(spsSessionDispatches).where(conditions(input)).then(rows => rows[0]!);
        await assertCurrent(input.companyId);
      }
    }
    return dto(row);
  }
  async function dispatch(input: Send, wake: (key: string) => Promise<{ id: string } | null>): Promise<{ runId: string; replayed: boolean }> {
    const requestDigest = validateSessionDispatch(input);
    await owned(input);
    const claim = await db.transaction(async tx => {
      const control = await lockSpsWorkspaceExecutionControl(tx, input.companyId);
      const session = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.id, input.sessionId),
        eq(agentTaskSessions.companyId, input.companyId))).for("update").then(rows => rows[0]);
      await assertCurrent(input.companyId);
      if (!session || session.userId !== null || session.status !== "active" || session.closedAt !== null
        || !session.taskKey.startsWith(`plugin:${pluginKey}:session:`)) throw unavailable();
      const existing = await tx.select().from(spsSessionDispatches).where(conditions(input)).then(rows => rows[0]);
      if (existing) {
        if (existing.sessionId !== input.sessionId || existing.requestDigest !== requestDigest) throw unavailable();
        return false;
      }
      const workspace = await tx.select({ status: companies.status }).from(companies)
        .where(eq(companies.id, input.companyId)).then(rows => rows[0]);
      if (control.state !== "running" || workspace?.status !== "active") throw unavailable();
      const outstanding = await tx.select({ id: spsSessionDispatches.id }).from(spsSessionDispatches)
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, spsSessionDispatches.runId)).where(and(
          eq(spsSessionDispatches.companyId, input.companyId), eq(spsSessionDispatches.pluginId, pluginId),
          eq(spsSessionDispatches.sessionId, input.sessionId),
          sql`(${spsSessionDispatches.state} <> 'submitted' or ${heartbeatRuns.status} is null or ${heartbeatRuns.status} not in ('succeeded','failed','cancelled','interrupted','timed_out'))`,
        )).limit(1);
      await assertCurrent(input.companyId);
      if (outstanding.length) throw unavailable();
      const inserted = await tx.insert(spsSessionDispatches).values({ companyId: input.companyId, pluginId,
        sessionId: input.sessionId, requestId: input.requestId, requestDigest }).onConflictDoNothing().returning();
      await assertCurrent(input.companyId);
      return inserted.length === 1;
    });
    await assertCurrent(input.companyId);
    if (!claim) {
      // Revalidate the digest even when another session won the unique-key race.
      const current = await db.select().from(spsSessionDispatches).where(conditions(input)).then(rows => rows[0]);
      if (!current || current.sessionId !== input.sessionId || current.requestDigest !== requestDigest) throw unavailable();
      const receipt = await getRequest(input);
      if (receipt?.state === "submitted" && receipt.runId) return { runId: receipt.runId, replayed: true };
      throw unavailable();
    }
    try {
      await assertCurrent(input.companyId);
      const run = await wake(wakeKey(input));
      if (!run || !uuid.test(run.id)) throw unavailable();
      const accepted = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.companyId, input.companyId))).then(rows => rows[0]);
      const conversation = accepted?.contextSnapshot?.spsPluginConversation as Record<string, unknown> | undefined;
      if (!accepted || conversation?.pluginKey !== pluginKey || conversation.sessionId !== input.sessionId
        || conversation.requestId !== input.requestId) throw unavailable();
      // Persist acceptance even if caller authority was revoked while wakeup ran.
      // No stale caller receives it; subsequent reads still recheck authority.
      await db.update(spsSessionDispatches).set({ state: "submitted", runId: run.id, updatedAt: new Date() })
        .where(and(conditions(input), eq(spsSessionDispatches.sessionId, input.sessionId)));
      await assertCurrent(input.companyId);
      return { runId: run.id, replayed: false };
    } catch {
      await db.update(spsSessionDispatches).set({ state: "uncertain", updatedAt: new Date() })
        .where(and(conditions(input), eq(spsSessionDispatches.state, "pending"))).catch(() => undefined);
      throw unavailable();
    }
  }
  return { dispatch, getRequest };
}
