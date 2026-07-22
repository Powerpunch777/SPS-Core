import { describe, expect, it } from "vitest";
import { readSpsMcpConfigFromEnv } from "./config.js";

describe("SPS MCP configuration", () => {
  it("prefers SPS environment variables over legacy compatibility values", () => {
    const config = readSpsMcpConfigFromEnv({
      SPS_API_URL: "https://sps.example.test/",
      SPS_API_KEY: "sps-token",
      SPS_COMPANY_ID: "sps-company",
      SPS_MCP_LEGACY_TOOL_NAMES: "true",
      PAPERCLIP_API_URL: "https://legacy.example.test",
      PAPERCLIP_API_KEY: "legacy-token",
      PAPERCLIP_COMPANY_ID: "legacy-company",
    });
    expect(config).toMatchObject({
      apiUrl: "https://sps.example.test/api",
      apiKey: "sps-token",
      companyId: "sps-company",
      legacyToolNames: true,
    });
  });

  it("accepts legacy variables while installations migrate", () => {
    const config = readSpsMcpConfigFromEnv({
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_API_KEY: "legacy-token",
      PAPERCLIP_AGENT_ID: "agent-1",
    });
    expect(config).toMatchObject({
      apiUrl: "http://localhost:3100/api",
      apiKey: "legacy-token",
      agentId: "agent-1",
      legacyToolNames: false,
    });
  });

  it("requires an SPS or legacy API URL and token", () => {
    expect(() => readSpsMcpConfigFromEnv({})).toThrow("Missing SPS_API_URL");
    expect(() => readSpsMcpConfigFromEnv({ SPS_API_URL: "http://localhost:3100" }))
      .toThrow("Missing SPS_API_KEY");
  });
});
