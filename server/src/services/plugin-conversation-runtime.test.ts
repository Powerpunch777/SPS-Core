import { describe, expect, it } from "vitest";
import { applyPluginConversationRuntime, preparePluginConversationContext, readPluginConversationContext } from "./plugin-conversation-runtime.js";

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
  it("preserves a valid execution policy on the validated conversation", () => {
    const context = { taskKey: "plugin:local.example:session:one", spsPluginConversation: {
      pluginKey: "local.example", sessionId: "session", message: "Hello",
      executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["zeta", "alpha"] },
    } };
    expect(readPluginConversationContext(context)).toEqual({ pluginKey: "local.example", sessionId: "session",
      message: "Hello", executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["alpha", "zeta"] } });
  });
  it("rejects malformed execution policies instead of silently running unrestricted", () => {
    const context = { taskKey: "plugin:local.example:session:one", spsPluginConversation: {
      pluginKey: "local.example", sessionId: "session", message: "Hello",
      executionPolicy: { mode: "unknown", toolNames: ["safe.tool"] },
    } };
    expect(() => applyPluginConversationRuntime(config, context)).toThrow(/unrestricted fallback is forbidden/i);
  });
  it("removes inherited resume wake prompts only for validated plugin conversations", () => {
    const context = { taskKey: "plugin:local.example:session:one", paperclipWake: { issue: "legacy" },
      spsPluginConversation: { pluginKey: "local.example", sessionId: "session", message: "Next turn" } };
    preparePluginConversationContext(context);
    expect(context).not.toHaveProperty("paperclipWake");
    expect(context.spsPluginConversation.message).toBe("Next turn");
    const ordinary = { taskKey: "issue:one", paperclipWake: { issue: "retained" } };
    preparePluginConversationContext(ordinary);
    expect(ordinary.paperclipWake.issue).toBe("retained");
  });
});
