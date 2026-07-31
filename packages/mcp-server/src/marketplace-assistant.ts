import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MarketplaceAssistantClient } from "./marketplace-assistant-client.js";
import type { MarketplaceAssistantConfig } from "./marketplace-assistant-config.js";

const searchInput = z.object({
  q: z.string().trim().optional(),
  category: z.string().trim().optional(),
  capability: z.string().trim().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

const getInput = z.object({
  pluginId: z.string().trim().min(1),
}).strict();

function safeError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const text = error instanceof Error ? error.message : "Marketplace Assistant request failed";
  return { isError: true, content: [{ type: "text", text }] };
}

export function createMarketplaceAssistantServer(config: MarketplaceAssistantConfig) {
  const server = new McpServer({ name: "sps-marketplace-assistant", version: "0.1.0" });
  const client = new MarketplaceAssistantClient(config);

  server.registerTool("search_marketplace_plugins", {
    description: "Search the read-only SPS Marketplace catalog.",
    inputSchema: searchInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await client.executeTool("search_marketplace_plugins", input)) }] };
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("get_marketplace_plugin", {
    description: "Read one Marketplace plugin's public metadata.",
    inputSchema: getInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await client.executeTool("get_marketplace_plugin", input)) }] };
    } catch (error) {
      return safeError(error);
    }
  });

  return { server, client };
}
