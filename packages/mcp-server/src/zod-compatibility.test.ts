import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSpsMcpServer } from "./index.js";

it("serializes and validates Core v3 schemas through the installed MCP SDK", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("[]", {
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const { server } = createSpsMcpServer({
    apiUrl: "http://localhost:3100/api", apiKey: "compatibility-test",
    companyId: null, agentId: null, runId: null,
  });
  const client = new Client({ name: "zod-compatibility", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const list = await client.listTools();
    const comments = list.tools.find(tool => tool.name === "spsListComments");
    expect(comments?.inputSchema.properties?.limit).toMatchObject({ type: "integer", maximum: 500 });
    const invalid = await client.callTool({ name: "spsListComments", arguments: { issueId: "PAP-1135", limit: 501 } });
    expect(invalid.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const valid = await client.callTool({ name: "spsListComments", arguments: { issueId: "PAP-1135", limit: 500 } });
    expect(valid.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("limit")).toBe("500");
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
  }
});

it("keeps the MCP HTTP adapter compatible with the pinned Hono Node runtime", async () => {
  const { server } = createSpsMcpServer({
    apiUrl: "http://localhost:3100/api", apiKey: "compatibility-test",
    companyId: null, agentId: null, runId: null,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const http = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const client = new Client({ name: "hono-compatibility", version: "1.0.0" });
  try {
    await server.connect(transport);
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Expected an owned loopback HTTP listener");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "spsListComments")).toBe(true);
    const invalid = await client.callTool({ name: "spsListComments", arguments: { issueId: "PAP-1135", limit: 501 } });
    expect(invalid.isError).toBe(true);
  } finally {
    try { await client.close(); }
    finally {
      try { await server.close(); }
      finally {
        http.closeAllConnections();
        if (http.listening) {
          await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
        }
      }
    }
  }
});
