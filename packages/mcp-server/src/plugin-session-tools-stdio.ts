#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createPluginSessionToolsServer,
  readPluginSessionToolsConfigFromEnv,
} from "./plugin-session-tools.js";

try {
  const { server } = createPluginSessionToolsServer(readPluginSessionToolsConfigFromEnv());
  await server.connect(new StdioServerTransport());
} catch {
  console.error("Failed to start SPS plugin session tools MCP server");
  process.exitCode = 1;
}
