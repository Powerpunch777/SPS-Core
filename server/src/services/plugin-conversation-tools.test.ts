import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPluginConversationExternalTools,
  resolvePluginConversationMcpEntryPath,
} from "./plugin-conversation-tools.js";

const input = {
  apiBaseUrl: "http://127.0.0.1:3100/api",
  authToken: "run-scoped-token",
  runId: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  pluginKey: "sps.example-plugin",
};

describe("Plugin conversation MCP injection helper", () => {
  it("builds only a local stdio server with the bound run and plugin environment", () => {
    const entryPath = path.resolve(process.cwd(), "runtime/plugin-session-tools-stdio.js");
    const externalTools = createPluginConversationExternalTools({ ...input, localEntryPath: entryPath });

    expect(externalTools).toEqual({
      mcpServers: [{
        kind: "stdio",
        name: "sps-plugin-session",
        command: process.execPath,
        args: [entryPath],
        env: [
          { name: "SPS_API_BASE_URL", value: input.apiBaseUrl },
          { name: "SPS_SCOPED_BEARER_TOKEN", value: input.authToken },
          { name: "SPS_RUN_ID", value: input.runId },
          { name: "SPS_COMPANY_ID", value: input.companyId },
          { name: "SPS_AGENT_ID", value: input.agentId },
          { name: "SPS_PLUGIN_KEY", value: input.pluginKey },
        ],
        identity: "sps.plugin.session",
        revision: "1",
      }],
    });
  });

  it("resolves the packaged MCP entry from the service module", () => {
    expect(resolvePluginConversationMcpEntryPath()).toMatch(
      /node_modules[\\/]@sps[\\/]mcp-server[\\/]dist[\\/]plugin-session-tools-stdio\.js$/,
    );
    expect(path.isAbsolute(resolvePluginConversationMcpEntryPath())).toBe(true);
  });

  it("rejects relative entry paths and missing binding fields", () => {
    expect(() => resolvePluginConversationMcpEntryPath("relative/stdio.js")).toThrow("must be absolute");
    expect(() => resolvePluginConversationMcpEntryPath("//server/share/stdio.js")).toThrow("must be absolute");
    expect(() => createPluginConversationExternalTools({ ...input, agentId: " " })).toThrow("agent id is required");
  });
});
