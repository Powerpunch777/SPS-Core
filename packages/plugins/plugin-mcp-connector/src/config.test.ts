import { describe, expect, it } from "vitest";
import { validateMcpConnectorConfig } from "./config.js";

describe("Remote MCP Connector config", () => {
  it("accepts HTTPS endpoints and exact allowlisted tools", () => {
    expect(validateMcpConnectorConfig({
      serverUrl: " https://mcp.example.com/api/mcp ",
      bearerToken: "secret-ref://mcp-token",
      allowedToolNames: ["search", "create_issue", "search"],
      requestTimeoutMs: "45000.9",
    })).toEqual({
      config: {
        serverUrl: "https://mcp.example.com/api/mcp",
        bearerTokenRef: "secret-ref://mcp-token",
        allowedToolNames: ["search", "create_issue"],
        requestTimeoutMs: 45000,
      },
      errors: [],
    });
  });

  it("rejects insecure endpoints and an implicit wildcard", () => {
    expect(validateMcpConnectorConfig({
      serverUrl: "http://mcp.example.com",
      allowedToolNames: ["*"],
    }).errors).toEqual([
      "serverUrl must use HTTPS unless it points at localhost.",
      "allowedToolNames must not contain a wildcard.",
    ]);
  });

  it("permits HTTP only for localhost development", () => {
    expect(validateMcpConnectorConfig({
      serverUrl: "http://127.0.0.1:8787/mcp",
      allowedToolNames: "list_projects, get_project",
    }).config).toMatchObject({
      serverUrl: "http://127.0.0.1:8787/mcp",
      allowedToolNames: ["list_projects", "get_project"],
    });
  });
});
