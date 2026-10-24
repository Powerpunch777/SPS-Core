import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceAssistantClient } from "./marketplace-assistant-client.js";
import { readMarketplaceAssistantConfigFromEnv } from "./marketplace-assistant-config.js";
import { createMarketplaceAssistantServer } from "./marketplace-assistant.js";

const config = {
  apiBaseUrl: "http://localhost:3100/api",
  bearerToken: "scoped-token",
  runId: "run-123",
  companyId: "company-123",
};

describe("SPS Marketplace Assistant MCP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requires all scoped environment values and normalizes the API URL", () => {
    expect(readMarketplaceAssistantConfigFromEnv({
      SPS_API_BASE_URL: "https://sps.example.test/",
      SPS_SCOPED_BEARER_TOKEN: "token",
      SPS_RUN_ID: "run",
      SPS_COMPANY_ID: "company",
    })).toMatchObject({ apiBaseUrl: "https://sps.example.test/api" });
    expect(() => readMarketplaceAssistantConfigFromEnv({})).toThrow("Missing SPS_API_BASE_URL");
  });

  it("sends only the scoped request contract and never logs credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ plugins: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new MarketplaceAssistantClient(config).executeTool("search_marketplace_plugins", { q: "builder" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3100/api/companies/company-123/marketplace/assistant/tools/search_marketplace_plugins");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer scoped-token",
      "X-Paperclip-Run-Id": "run-123",
    });
    expect(init.body).toBe(JSON.stringify({ input: { q: "builder" } }));
  });

  it("exposes exactly two tools through the MCP protocol", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ plugins: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createMarketplaceAssistantServer(config);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "search_marketplace_plugins",
      "get_marketplace_plugin",
    ]);
    await expect(client.callTool({ name: "search_marketplace_plugins", arguments: {} })).resolves.toMatchObject({
      content: [{ type: "text" }],
    });
    await client.close();
    await server.close();
  });

  it("does not expose bearer tokens in MCP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret body", { status: 403 })));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = createMarketplaceAssistantServer(config);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "get_marketplace_plugin", arguments: { pluginId: "x" } });
    expect(JSON.stringify(result)).not.toContain("scoped-token");
    expect(JSON.stringify(result)).not.toContain("secret body");
    await client.close();
    await server.close();
  });

  it("preserves bounded structured Core denial details without exposing an arbitrary body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "marketplace_assistant_scope_denied",
      error: "Marketplace Assistant tokens can only execute Core marketplace tools",
      ignored: "scoped-token",
    }), { status: 403, headers: { "content-type": "application/json" } })));

    await expect(new MarketplaceAssistantClient(config).executeTool("search_marketplace_plugins", {}))
      .rejects.toThrow(/403 \(marketplace_assistant_scope_denied:/);
  });
});
