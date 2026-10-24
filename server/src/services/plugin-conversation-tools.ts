import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExternalToolContext } from "@paperclipai/adapter-utils";

export interface PluginConversationExternalToolsInput {
  apiBaseUrl: string;
  authToken: string;
  runId: string;
  companyId: string;
  agentId: string;
  pluginKey: string;
  localEntryPath?: string;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Plugin conversation MCP ${name} is required.`);
  return normalized;
}

export function resolvePluginConversationMcpEntryPath(localEntryPath?: string): string {
  const configured = localEntryPath?.trim();
  if (configured) {
    if (
      !path.isAbsolute(configured)
      || configured.startsWith("//")
      || path.win32.normalize(configured).startsWith("\\\\")
    ) {
      throw new Error("Plugin conversation MCP entry path must be absolute.");
    }
    return configured;
  }

  const servicesDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    servicesDir,
    "../../node_modules/@sps/mcp-server/dist/plugin-session-tools-stdio.js",
  );
}

export function createPluginConversationExternalTools(
  input: PluginConversationExternalToolsInput,
): AdapterExternalToolContext {
  const entryPath = resolvePluginConversationMcpEntryPath(input.localEntryPath);
  const apiBaseUrl = required(input.apiBaseUrl, "API base URL");
  const authToken = required(input.authToken, "auth token");
  const runId = required(input.runId, "run id");
  const companyId = required(input.companyId, "company id");
  const agentId = required(input.agentId, "agent id");
  const pluginKey = required(input.pluginKey, "plugin key");

  return {
    mcpServers: [{
      kind: "stdio",
      name: "sps-plugin-session",
      command: process.execPath,
      args: [entryPath],
      env: [
        { name: "SPS_API_BASE_URL", value: apiBaseUrl },
        { name: "SPS_SCOPED_BEARER_TOKEN", value: authToken },
        { name: "SPS_RUN_ID", value: runId },
        { name: "SPS_COMPANY_ID", value: companyId },
        { name: "SPS_AGENT_ID", value: agentId },
        { name: "SPS_PLUGIN_KEY", value: pluginKey },
      ],
      identity: "sps.plugin.session",
      revision: "1",
    }],
  };
}
