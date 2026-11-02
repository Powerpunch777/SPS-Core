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
