import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: {
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn(),
  },
  connectRemoteMcp: vi.fn(),
}));

vi.mock("./mcp-client.js", () => ({ connectRemoteMcp: mocks.connectRemoteMcp }));

describe("SPS Remote MCP Connector plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.connection.listTools.mockReset();
    mocks.connection.callTool.mockReset();
    mocks.connection.close.mockReset();
    mocks.connectRemoteMcp.mockReset();
    mocks.connection.close.mockResolvedValue(undefined);
    mocks.connectRemoteMcp.mockResolvedValue(mocks.connection);
  });

  it("discovers only allowlisted tools and routes an SPS call back to the remote name", async () => {
    mocks.connection.listTools.mockResolvedValue([
      {
        name: "search projects",
        description: "Search remote projects.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      { name: "delete_everything" },
    ]);
    mocks.connection.callTool.mockResolvedValue({ content: [{ type: "text", text: "found" }] });
    const replaceDynamic = vi.fn().mockResolvedValue({ registered: 1 });
    const plugin = (await import("./plugin.js")).default;

    await plugin.definition.setup({
      config: {
        get: async () => ({
          serverUrl: "https://mcp.example.com/mcp",
          bearerToken: "secret-ref://mcp-token",
          allowedToolNames: ["search projects"],
        }),
      },
      secrets: { resolve: async () => "token-value" },
      http: { fetch: vi.fn() },
      tools: { replaceDynamic },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never);

    expect(replaceDynamic).toHaveBeenCalledTimes(1);
    const registered = replaceDynamic.mock.calls[0]?.[0] as Array<{
      name: string;
      fn: (params: unknown) => Promise<{ content?: string }>;
    }>;
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("mcp_search_projects");

    await expect(registered[0]?.fn({ query: "roadmap" })).resolves.toMatchObject({
      content: expect.stringContaining("found"),
    });
    expect(mocks.connection.callTool).toHaveBeenCalledWith("search projects", { query: "roadmap" });
    expect(mocks.connection.close).toHaveBeenCalledTimes(2);
  });

  it("clears dynamic tools when discovery fails", async () => {
    mocks.connectRemoteMcp.mockRejectedValue(new Error("remote unavailable"));
    const replaceDynamic = vi.fn().mockResolvedValue({ registered: 0 });
    const plugin = (await import("./plugin.js")).default;

    await plugin.definition.setup({
      config: {
        get: async () => ({
          serverUrl: "https://mcp.example.com/mcp",
          allowedToolNames: ["search"],
        }),
      },
      secrets: { resolve: async () => "unused" },
      http: { fetch: vi.fn() },
      tools: { replaceDynamic },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never);

    expect(replaceDynamic).toHaveBeenCalledWith([]);
    await expect(plugin.definition.onHealth?.()).resolves.toMatchObject({ status: "degraded" });
  });
});
