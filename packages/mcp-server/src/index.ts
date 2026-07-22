import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SpsApiClient } from "./client.js";
import { readSpsMcpConfigFromEnv, type SpsMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createSpsMcpServer(config: SpsMcpConfig = readSpsMcpConfigFromEnv()) {
  const server = new McpServer({
    name: "sps",
    version: "0.1.0",
  });

  const client = new SpsApiClient(config);
  const tools = createToolDefinitions(client, { legacyToolNames: config.legacyToolNames });
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: SpsMcpConfig = readSpsMcpConfigFromEnv()) {
  const { server } = createSpsMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** @deprecated Use createSpsMcpServer. */
export const createPaperclipMcpServer = createSpsMcpServer;
