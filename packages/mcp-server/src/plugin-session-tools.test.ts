import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginSessionToolsServer,
  PluginSessionToolsClient,
  PLUGIN_SESSION_TOOLS_TIMEOUT_MS,
  readPluginSessionToolsConfigFromEnv,
  type PluginSessionToolsConfig,
} from "./plugin-session-tools.js";

const config: PluginSessionToolsConfig = {
  apiBaseUrl: "http://127.0.0.1:3100/api",
  bearerToken: "scoped-token",
  runId: "run-123",
  companyId: "company-123",
  agentId: "agent-123",
  pluginKey: "sps.example-plugin",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMcpClient<T>(
  configInput: PluginSessionToolsConfig,
  run: (client: Client) => Promise<T>,
  options: ConstructorParameters<typeof PluginSessionToolsClient>[1] = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = createPluginSessionToolsServer(configInput, options);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function firstText(result: unknown): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) {
    throw new Error("Expected an MCP text result");
  }
  const first = (result as { content: Array<unknown> }).content[0];
  if (!first || typeof first !== "object" || typeof (first as { text?: unknown }).text !== "string") {
    throw new Error("Expected an MCP text block");
  }
  return (first as { text: string }).text;
}

describe("Plugin session tools MCP", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("requires the bound run and plugin environment and normalizes loopback API URLs", () => {
    const env = {
      SPS_API_BASE_URL: "http://localhost:3100/",
      SPS_SCOPED_BEARER_TOKEN: "token",
      SPS_RUN_ID: "run",
      SPS_COMPANY_ID: "company",
      SPS_AGENT_ID: "agent",
      SPS_PLUGIN_KEY: "sps.example-plugin",
    };
    expect(readPluginSessionToolsConfigFromEnv(env)).toMatchObject({
      apiBaseUrl: "http://localhost:3100/api",
      pluginKey: "sps.example-plugin",
    });
    expect(readPluginSessionToolsConfigFromEnv({ ...env, SPS_API_BASE_URL: "http://[::1]:3100/api/" }).apiBaseUrl)
      .toBe("http://[::1]:3100/api");
    expect(readPluginSessionToolsConfigFromEnv({ ...env, SPS_API_BASE_URL: "http://127.0.0.1:3100/api" }).apiBaseUrl)
      .toBe("http://127.0.0.1:3100/api");
    expect(() => readPluginSessionToolsConfigFromEnv({})).toThrow("Missing SPS_API_BASE_URL");
    expect(() => readPluginSessionToolsConfigFromEnv({ ...env, SPS_AGENT_ID: " " })).toThrow("Missing SPS_AGENT_ID");
  });

  it.each([
    "https://localhost:3100",
    "http://example.test",
    "http://127.0.0.2:3100",
    "http://user:pass@localhost:3100",
    "http://@localhost:3100",
    "http://localhost:3100?x=1",
    "http://localhost:3100#fragment",
  ])("rejects non-local or decorated API base URL %s", (apiBaseUrl) => {
    expect(() => readPluginSessionToolsConfigFromEnv({
      SPS_API_BASE_URL: apiBaseUrl,
      SPS_SCOPED_BEARER_TOKEN: "token",
      SPS_RUN_ID: "run",
      SPS_COMPANY_ID: "company",
      SPS_AGENT_ID: "agent",
      SPS_PLUGIN_KEY: "sps.example-plugin",
    })).toThrow("SPS_API_BASE_URL must");
  });

  it("exposes exactly the two generic tools and lists only descriptors owned by this plugin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
      { pluginId: config.pluginKey, name: `${config.pluginKey}:do-work`, description: "Owned" },
      { pluginId: "11111111-1111-4111-8111-111111111111", name: `${config.pluginKey}:uuid-owned`, description: "Core descriptor" },
      { pluginId: "other.plugin", name: "other.plugin:secret", description: "Foreign" },
      { pluginId: config.pluginKey, name: "other.plugin:mislabelled" },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await withMcpClient(config, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "execute_plugin_tool",
        "list_plugin_tools",
      ]);
      const executeTool = tools.tools.find((tool) => tool.name === "execute_plugin_tool");
      expect(executeTool?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
      expect(executeTool?.annotations).not.toHaveProperty("destructiveHint");
      return client.callTool({ name: "list_plugin_tools", arguments: {} });
    });

    expect(JSON.parse(firstText(result))).toEqual([
      { pluginId: config.pluginKey, name: `${config.pluginKey}:do-work`, description: "Owned" },
      { pluginId: "11111111-1111-4111-8111-111111111111", name: `${config.pluginKey}:uuid-owned`, description: "Core descriptor" },
    ]);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe(
      `http://127.0.0.1:3100/api/plugins/tools?pluginId=${encodeURIComponent(config.pluginKey)}`,
    );
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ Authorization: "Bearer scoped-token" });
  });

  it("executes only own-plugin names with the bound identity and no project id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ reportId: "report-1", status: "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await new PluginSessionToolsClient(config).executePluginTool(
      `${config.pluginKey}:delegate`,
      { objective: "inspect" },
    );

    expect(response).toEqual({ reportId: "report-1", status: "queued" });
    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.toString()).toBe("http://127.0.0.1:3100/api/plugins/tools/execute");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer scoped-token",
      "X-Paperclip-Run-Id": "run-123",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      tool: `${config.pluginKey}:delegate`,
      parameters: { objective: "inspect" },
      runContext: { agentId: "agent-123", runId: "run-123", companyId: "company-123" },
    });
  });

  it("refuses a cross-plugin tool before making an HTTP request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new PluginSessionToolsClient(config).executePluginTool(
      "other.plugin:delegate",
      {},
    )).rejects.toThrow("outside the configured plugin namespace");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores caller-supplied identity or project fields at the MCP boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await withMcpClient(config, (client) => client.callTool({
      name: "execute_plugin_tool",
      arguments: {
        toolName: `${config.pluginKey}:delegate`,
        parameters: {},
        projectId: "caller-project",
        runContext: { agentId: "caller-agent" },
      },
    }));
    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body)).runContext).toEqual({
      agentId: "agent-123",
      runId: "run-123",
      companyId: "company-123",
    });
    expect(String(init.body)).not.toContain("caller-agent");
    expect(String(init.body)).not.toContain("caller-project");
  });

  it("returns plugin error results marked as MCP errors", async () => {
    const pluginResult = { error: "Tool rejected the objective", data: { code: "invalid" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(pluginResult)));
    const result = await withMcpClient(config, (client) => client.callTool({
      name: "execute_plugin_tool",
      arguments: { toolName: `${config.pluginKey}:delegate`, parameters: {} },
    }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toEqual(pluginResult);
  });

  it("marks nested Core ToolExecutionResult errors as MCP errors", async () => {
    const dispatcherResult = { success: true, result: { error: "Nested tool failure", data: null } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(dispatcherResult)));
    const result = await withMcpClient(config, (client) => client.callTool({
      name: "execute_plugin_tool",
      arguments: { toolName: `${config.pluginKey}:delegate`, parameters: {} },
    }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(firstText(result))).toEqual(dispatcherResult);
  });

  it("does not expose HTTP response bodies or bearer tokens in errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "scoped-token leaked" }, 403)));
    const result = await withMcpClient(config, (client) => client.callTool({
      name: "execute_plugin_tool",
      arguments: { toolName: `${config.pluginKey}:delegate`, parameters: {} },
    }));
    const serialized = JSON.stringify(result);
    expect(result.isError).toBe(true);
    expect(serialized).toContain("HTTP 403");
    expect(serialized).not.toContain("scoped-token");
    expect(serialized).not.toContain("leaked");
  });

  it("bounds requests, rejects redirects, and never retries execution", async () => {
    expect(() => new PluginSessionToolsClient(config, {
      timeoutMs: PLUGIN_SESSION_TOOLS_TIMEOUT_MS + 1,
    })).toThrow("request timeout must be between");
    vi.useFakeTimers();
    const fetchMock = vi.fn((
      _url: URL | RequestInfo,
      init: RequestInit = {},
    ) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const client = new PluginSessionToolsClient(config, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 25,
    });
    const pending = client.executePluginTool(`${config.pluginKey}:delegate`, {});
    const rejected = expect(pending).rejects.toThrow("request timed out");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("does not expose unrelated API or lifecycle methods", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await new PluginSessionToolsClient(config).listPluginTools();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/plugins/tools?");
  });
});
