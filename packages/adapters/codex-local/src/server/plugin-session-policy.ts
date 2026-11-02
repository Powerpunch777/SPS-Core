import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseSpsSessionExecutionPolicy } from "@paperclipai/adapter-utils/sps-session-policy";

const CODEX_PLUGIN_SESSION_ARGS = [
  "--sandbox", "read-only",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "-c", 'approval_policy="never"',
  "-c", 'web_search="disabled"',
  "-c", 'mcp_servers.sps-plugin-session.enabled_tools=["list_plugin_tools", "execute_plugin_tool"]',
  "-c", 'mcp_servers.sps-plugin-session.tools.list_plugin_tools.approval_mode="approve"',
  "-c", 'mcp_servers.sps-plugin-session.tools.execute_plugin_tool.approval_mode="approve"',
  ...[
    "shell_tool",
    "multi_agent",
    "plugins",
    "apps",
    "hooks",
    "computer_use",
    "browser_use",
    "in_app_browser",
    "code_mode_host",
    "image_generation",
    "workspace_dependencies",
  ].flatMap((feature) => ["--disable", feature]),
];

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAFE_PLUGIN_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,149}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(message: string): never {
  throw new Error(`Codex plugin session rejected: ${message}`);
}

function validatePluginConversation(context: Record<string, unknown>, conversation: Record<string, unknown>): void {
  const pluginKey = conversation.pluginKey;
  const sessionId = conversation.sessionId;
  const message = conversation.message;
  const taskKey = context.taskKey;
  if (typeof pluginKey !== "string" || !SAFE_PLUGIN_KEY.test(pluginKey)
    || typeof sessionId !== "string" || !UUID.test(sessionId)
    || typeof message !== "string" || !message.trim()
    || typeof taskKey !== "string" || !taskKey.startsWith(`plugin:${pluginKey}:session:`)) {
    reject("plugin conversation metadata is invalid");
  }
}

function validateBridge(externalTools: AdapterExecutionContext["externalTools"]): void {
  const servers = externalTools?.mcpServers;
  if (!Array.isArray(servers) || servers.length !== 1) {
    reject("the required plugin session MCP bridge is unavailable");
  }
  const [server] = servers;
  if (!isRecord(server) || server.kind !== "stdio"
    || server.name !== "sps-plugin-session"
    || server.identity !== "sps.plugin.session") {
    reject("the configured MCP server is not the plugin session bridge");
  }
}

function hasCustomArgs(config: Record<string, unknown>): boolean {
  return [config.extraArgs, config.args].some((value) =>
    value !== undefined && (!Array.isArray(value) || value.length !== 0),
  );
}

/** Apply the narrow Codex runtime profile only to explicitly scoped plugin sessions. */
export function applyCodexPluginSessionPolicy(ctx: AdapterExecutionContext): AdapterExecutionContext {
  const conversationValue = ctx.context.spsPluginConversation;
  if (!isRecord(conversationValue) || conversationValue.executionPolicy === undefined) return ctx;

  const policy = parseSpsSessionExecutionPolicy(conversationValue.executionPolicy);
  if (!policy) reject("execution policy is missing");
  validatePluginConversation(ctx.context, conversationValue);
  validateBridge(ctx.externalTools);

  const command = ctx.config.command;
  if (command !== undefined && command !== "codex" && command !== "codex.exe") {
    reject("custom Codex commands are not allowed");
  }
  if (hasCustomArgs(ctx.config)) reject("custom Codex arguments are not allowed");
  const executionTarget = ctx.executionTarget;
  if (executionTarget !== undefined && executionTarget !== null
    && (!isRecord(executionTarget) || executionTarget.kind !== "local")) {
    reject("remote execution targets are not allowed");
  }
  const legacyRemoteExecution = ctx.executionTransport?.remoteExecution;
  if (legacyRemoteExecution !== undefined && legacyRemoteExecution !== null) {
    reject("legacy remote execution is not allowed");
  }

  return {
    ...ctx,
    config: {
      ...ctx.config,
      engine: "cli",
      search: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
      args: [],
      extraArgs: [...CODEX_PLUGIN_SESSION_ARGS],
    },
  };
}
