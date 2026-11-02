import { parseSpsSessionExecutionPolicy, type SpsSessionExecutionPolicy } from "@paperclipai/adapter-utils/sps-session-policy";

/** Stored session metadata cannot replace Core-owned identity or restrictions. */
export function createSpsSessionDispatchContext(input: {
  pluginKey: string; sessionId: string; taskKey: string; prompt: string;
  requestId?: string; reason?: string; executionPolicy?: SpsSessionExecutionPolicy; sessionContext?: Record<string, unknown> | null;
}) {
  const executionPolicy = parseSpsSessionExecutionPolicy(input.executionPolicy);
  return { ...(input.sessionContext ?? {}), taskKey: input.taskKey,
    spsPluginConversation: { pluginKey: input.pluginKey, sessionId: input.sessionId, message: input.prompt,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(executionPolicy && input.reason !== undefined ? { reason: input.reason } : {}),
      ...(executionPolicy ? { executionPolicy } : {}) }, wakeSource: "automation", wakeTriggerDetail: "system" };
}

export function isSpsSessionDispatchContext(context: Record<string, unknown>, idempotencyKey: string | null | undefined): boolean {
  const value = context.spsPluginConversation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
  return typeof message.pluginKey === "string" && message.pluginKey.length > 0
    && typeof message.sessionId === "string" && uuid.test(message.sessionId)
    && typeof message.requestId === "string" && uuid.test(message.requestId)
    && typeof context.taskKey === "string" && context.taskKey.startsWith(`plugin:${message.pluginKey}:session:`)
    && typeof idempotencyKey === "string" && idempotencyKey.startsWith("sps-session:")
    && idempotencyKey.endsWith(`:${message.requestId}`);
}
