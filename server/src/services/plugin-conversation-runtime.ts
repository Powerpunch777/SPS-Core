type RecordValue = Record<string, unknown>;

/** Session transport is generic; workflow prompts remain plugin-owned. */
export function applyPluginConversationRuntime(config: RecordValue, context: RecordValue): RecordValue {
  const value = context.spsPluginConversation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return config;
  const conversation = value as RecordValue;
  if (typeof conversation.pluginKey !== "string" || typeof conversation.sessionId !== "string"
    || typeof conversation.message !== "string" || !conversation.message.trim()
    || !String(context.taskKey ?? "").startsWith(`plugin:${conversation.pluginKey}:session:`)) return config;
  return { ...config, promptTemplate: "{{context.spsPluginConversation.message}}" };
}
