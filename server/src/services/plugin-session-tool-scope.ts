import { and, eq } from "drizzle-orm";
import { agents, agentTaskSessions, heartbeatRuns, type Db } from "../compat/paperclip/db.js";
import { readPluginConversationContext } from "./plugin-conversation-runtime.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** A projectless call cannot borrow a different run, session, or plugin scope. */
export async function resolvePluginSessionToolScope(db: Db, input: {
  agentId: string; companyId: string; runId: string;
}): Promise<string | null> {
  if (![input.agentId, input.companyId, input.runId].every(value => typeof value === "string" && uuid.test(value))) return null;
  const agent = await db.select({ companyId: agents.companyId, status: agents.status }).from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .limit(1).then(rows => rows[0]);
  if (agent?.companyId !== input.companyId || !["idle", "running", "active"].includes(agent.status)) return null;
  const run = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.companyId, input.companyId),
  )).limit(1).then(rows => rows[0]);
  if (!run || run.agentId !== input.agentId || run.companyId !== input.companyId || run.status !== "running") return null;
  const context = run.contextSnapshot;
  if (context?.spsSessionCancellationRequested === true) return null;
  const conversation = context && readPluginConversationContext(context);
  if (!conversation || !uuid.test(conversation.sessionId)) return null;
  const session = await db.select().from(agentTaskSessions).where(and(
    eq(agentTaskSessions.id, conversation.sessionId), eq(agentTaskSessions.agentId, input.agentId),
    eq(agentTaskSessions.companyId, input.companyId),
  )).limit(1).then(rows => rows[0]);
  if (!session || session.id !== conversation.sessionId || session.agentId !== input.agentId
    || session.companyId !== input.companyId || session.status !== "active" || session.closedAt != null
    || session.taskKey !== context?.taskKey
    || !session.taskKey.startsWith(`plugin:${conversation.pluginKey}:session:`)) return null;
  return conversation.pluginKey;
}
