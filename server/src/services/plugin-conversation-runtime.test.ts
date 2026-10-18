import { describe, expect, it } from "vitest";
import { applyPluginConversationRuntime } from "./plugin-conversation-runtime.js";

describe("plugin conversation runtime", () => {
  const config = { model: "test", command: "codex", instructionsFilePath: "/approved/AGENTS.md" };
  it("passes plugin messages without the inherited issue-work default, preserving Agent settings", () => {
    expect(applyPluginConversationRuntime(config, { taskKey: "plugin:local.example:session:one",
      spsPluginConversation: { pluginKey: "local.example", sessionId: "session", message: "Hello" } }))
      .toEqual({ ...config, promptTemplate: "{{context.spsPluginConversation.message}}" });
  });
  it("does not change ordinary runs or accept mismatched session metadata", () => {
    expect(applyPluginConversationRuntime(config, {})).toBe(config);
    expect(applyPluginConversationRuntime(config, { taskKey: "issue:one", spsPluginConversation: { pluginKey: "local.example", sessionId: "s", message: "Hello" } })).toBe(config);
    expect(applyPluginConversationRuntime(config, { taskKey: "plugin:other:session:one", spsPluginConversation: { pluginKey: "local.example", sessionId: "s", message: "Hello" } })).toBe(config);
  });
});
