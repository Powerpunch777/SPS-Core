import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "sps.mcp-connector",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "SPS Remote MCP Connector",
  description:
    "Connects an allowlisted HTTPS MCP server and exposes its selected tools to SPS agents.",
  author: "SPS",
  categories: ["automation"],
  capabilities: [
    "agent.tools.dynamic.register",
    "http.outbound",
    "secrets.read-ref",
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      serverUrl: {
        type: "string",
        format: "uri",
        description: "HTTPS Streamable HTTP MCP endpoint. HTTP is accepted only for localhost development.",
      },
      bearerToken: {
        type: "string",
        format: "secret-ref",
        description: "Optional Bearer token stored as an SPS secret reference.",
      },
      allowedToolNames: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
        description: "Exact remote MCP tool names that SPS may expose. A wildcard is never accepted.",
      },
      requestTimeoutMs: {
        type: "number",
        minimum: 1000,
        maximum: 300000,
        default: 30000,
        description: "Per-request timeout for calls to the remote MCP server.",
      },
    },
    required: ["serverUrl", "allowedToolNames"],
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
