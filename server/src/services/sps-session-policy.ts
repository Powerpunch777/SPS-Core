import { and, eq } from "drizzle-orm";
import { agentTaskSessions, type Db } from "../compat/paperclip/db.js";
import { describeSpsAgentExecution } from "./sps-agent-execution-descriptor.js";

/** Configuration support only. It is not a backend probe or OS isolation proof. */
export async function describeSpsSessionPolicySupport(db: Db, input: {
  companyId: string; sessionId: string; pluginKey: string;
}, isAdapterRegistered: (type: string) => boolean, assertCurrent: () => Promise<void>) {
  const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if (![input.companyId, input.sessionId].every(value => typeof value === "string" && uuid.test(value))) throw new Error("Session policy support is unavailable.");
  await assertCurrent();
  const [session] = await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.id, input.sessionId),
  ));
  await assertCurrent();
  if (!session || session.companyId !== input.companyId || session.id !== input.sessionId || session.userId !== null
    || session.status !== "active" || session.closedAt !== null || !session.taskKey.startsWith(`plugin:${input.pluginKey}:session:`)) {
    throw new Error("Session policy support is unavailable.");
  }
  const descriptor = await describeSpsAgentExecution(db, { companyId: input.companyId, agentId: session.agentId }, isAdapterRegistered);
  await assertCurrent();
  const modes: Array<"plugin-tools-only-v1"> = descriptor.adapterType === "codex_local" && descriptor.state === "configured"
    && descriptor.adapterRegistration === "registered" && descriptor.executionOwner === "adapter" ? ["plugin-tools-only-v1"] : [];
  return { schemaVersion: 1 as const, modes, enforcement: "dispatch-and-run" as const,
    readiness: "unknown" as const, osIsolation: "not-certified" as const };
}
