#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMarketplaceAssistantServer } from "./marketplace-assistant.js";
import { readMarketplaceAssistantConfigFromEnv } from "./marketplace-assistant-config.js";

try {
  const { server } = createMarketplaceAssistantServer(readMarketplaceAssistantConfigFromEnv());
  await server.connect(new StdioServerTransport());
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to start SPS Marketplace Assistant MCP server";
  console.error(message);
  process.exitCode = 1;
}
