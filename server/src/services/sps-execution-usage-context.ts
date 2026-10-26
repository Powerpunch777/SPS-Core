import type { SpsUsageReceiptScope } from "./sps-execution-usage-receipt.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Use only Core-persisted execution ownership, never current Agent settings. */
export function spsAgentUsageReceiptScope(run: {
  id: string; companyId: string; agentId: string; contextSnapshot: unknown;
}, expectedPluginKey?: string): SpsUsageReceiptScope | null {
  const context = record(run.contextSnapshot), conversation = record(context.spsPluginConversation);
  const pluginKey = conversation.pluginKey, sessionId = conversation.sessionId;
  if (![run.id, run.companyId, run.agentId, sessionId].every(id => typeof id === "string" && uuid.test(id))
    || typeof pluginKey !== "string" || !/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(pluginKey)
    || expectedPluginKey !== undefined && pluginKey !== expectedPluginKey
    || typeof context.taskKey !== "string" || !context.taskKey.startsWith(`plugin:${pluginKey}:session:`)) return null;
  return { companyId: run.companyId.toLowerCase(), runId: run.id.toLowerCase(), agentId: run.agentId.toLowerCase(),
    pluginKey, sessionId: (sessionId as string).toLowerCase() };
}
