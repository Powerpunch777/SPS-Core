import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { applyCodexPluginSessionPolicy } from "./plugin-session-policy.js";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";

function bridge() {
  return {
    mcpServers: [{
      kind: "stdio",
      name: "sps-plugin-session",
      command: "node",
      args: ["bridge.js"],
      identity: "sps.plugin.session",
      revision: "test-revision",
    }],
  };
}

function buildContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Codex", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "acp", model: "gpt-6", cwd: "C:/workspace", timeoutSec: 75 },
    context: {
      taskKey: `plugin:sample-plugin:session:${sessionId}`,
      spsPluginConversation: {
        pluginKey: "sample-plugin",
        sessionId,
        message: "Run the plugin task",
        executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["inspect"] },
      },
    },
    externalTools: bridge(),
    executionTarget: { kind: "local" },
    onLog: async () => {},
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

describe("Codex plugin session runtime policy", () => {
  it("uses a bounded ephemeral CLI profile without mutating the input config", () => {
    const ctx = buildContext();
    const configBefore = structuredClone(ctx.config);
    const contextBefore = structuredClone(ctx.context);

    const guarded = applyCodexPluginSessionPolicy(ctx);

    expect(guarded).not.toBe(ctx);
    expect(guarded.config).not.toBe(ctx.config);
    expect(guarded.config).toMatchObject({
      engine: "cli",
      model: "gpt-6",
      cwd: "C:/workspace",
      timeoutSec: 75,
      search: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
      args: [],
    });
    expect(guarded.config.extraArgs).toEqual([
      "--sandbox", "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-c", 'approval_policy="never"',
      "-c", 'web_search="disabled"',
      "-c", 'mcp_servers.sps-plugin-session.enabled_tools=["list_plugin_tools", "execute_plugin_tool"]',
      "--disable", "shell_tool",
      "--disable", "multi_agent",
      "--disable", "plugins",
      "--disable", "apps",
      "--disable", "hooks",
      "--disable", "computer_use",
      "--disable", "browser_use",
      "--disable", "in_app_browser",
      "--disable", "code_mode_host",
      "--disable", "image_generation",
      "--disable", "workspace_dependencies",
    ]);
    expect(ctx.config).toEqual(configBefore);
    expect(ctx.context).toEqual(contextBefore);
  });

  it.each([
    ["custom argument", { extraArgs: ["--some-custom-flag"] }],
    ["yolo argument", { extraArgs: ["--yolo"] }],
    ["legacy args", { args: ["--dangerously-bypass-approvals-and-sandbox"] }],
    ["custom command", { command: "codex-wrapper" }],
  ])("rejects %s", (_name, config) => {
    expect(() => applyCodexPluginSessionPolicy(buildContext({
      config: { ...buildContext().config, ...config },
    }))).toThrow("Codex plugin session rejected");
  });

  it("forces CLI when ACP was configured", () => {
    const guarded = applyCodexPluginSessionPolicy(buildContext({
      config: { ...buildContext().config, engine: "acp" },
    }));
    expect(guarded.config.engine).toBe("cli");
  });

  it.each([
    ["remote execution target", { executionTarget: { kind: "remote", transport: "sandbox" } }],
    ["unknown execution target", { executionTarget: { kind: "unknown" } }],
    ["malformed execution target", { executionTarget: "local" }],
    ["legacy remote execution", { executionTransport: { remoteExecution: { remoteCwd: "/work" } } }],
  ])("rejects %s", (_name, override) => {
    expect(() => applyCodexPluginSessionPolicy(buildContext(override))).toThrow("Codex plugin session rejected");
  });

  it.each([
    ["missing bridge", { externalTools: undefined }],
    ["foreign bridge", { externalTools: { mcpServers: [{ ...bridge().mcpServers[0], identity: "other.bridge" }] } }],
    ["extra MCP server", { externalTools: { mcpServers: [...bridge().mcpServers, { ...bridge().mcpServers[0], name: "other" }] } }],
  ])("rejects %s", (_name, override) => {
    expect(() => applyCodexPluginSessionPolicy(buildContext(override))).toThrow("bridge");
  });

  it.each([
    ["unsupported mode", { mode: "unrestricted", toolNames: ["inspect"] }],
    ["empty tools", { mode: "plugin-tools-only-v1", toolNames: [] }],
    ["extra policy property", { mode: "plugin-tools-only-v1", toolNames: ["inspect"], unrestricted: true }],
  ])("rejects malformed provided policy (%s)", (_name, executionPolicy) => {
    const ctx = buildContext();
    (ctx.context.spsPluginConversation as Record<string, unknown>).executionPolicy = executionPolicy;
    expect(() => applyCodexPluginSessionPolicy(ctx)).toThrow("Invalid SPS session execution policy");
  });

  it("rejects invalid or mismatched plugin conversation metadata", () => {
    const ctx = buildContext();
    (ctx.context.spsPluginConversation as Record<string, unknown>).sessionId = "not-a-session-id";
    expect(() => applyCodexPluginSessionPolicy(ctx)).toThrow("plugin conversation metadata is invalid");

    const mismatchedTask = buildContext();
    mismatchedTask.context.taskKey = `plugin:another-plugin:session:${sessionId}`;
    expect(() => applyCodexPluginSessionPolicy(mismatchedTask)).toThrow("plugin conversation metadata is invalid");

    const emptyMessage = buildContext();
    (emptyMessage.context.spsPluginConversation as Record<string, unknown>).message = "  ";
    expect(() => applyCodexPluginSessionPolicy(emptyMessage)).toThrow("plugin conversation metadata is invalid");
  });

  it("returns ordinary runs unchanged when there is no execution policy", () => {
    const ctx = buildContext({
      config: { engine: "acp", extraArgs: ["--caller-option"] },
      context: {},
      externalTools: undefined,
    });
    expect(applyCodexPluginSessionPolicy(ctx)).toBe(ctx);
    expect(ctx.config).toEqual({ engine: "acp", extraArgs: ["--caller-option"] });
  });
});
