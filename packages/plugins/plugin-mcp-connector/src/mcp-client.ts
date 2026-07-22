import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PluginHttpClient } from "@paperclipai/plugin-sdk";
import type { RemoteMcpTool } from "./tool-mapping.js";

export interface RemoteMcpConnectionInput {
  serverUrl: string;
  bearerToken: string | null;
  http: PluginHttpClient;
  requestTimeoutMs: number;
}

export interface RemoteMcpConnection {
  listTools(): Promise<RemoteMcpTool[]>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function asRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
}

export async function connectRemoteMcp(input: RemoteMcpConnectionInput): Promise<RemoteMcpConnection> {
  const headers = new Headers();
  if (input.bearerToken) headers.set("Authorization", `Bearer ${input.bearerToken}`);

  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl), {
    requestInit: { headers },
    fetch: (request, init) => input.http.fetch(asRequestUrl(request), {
      ...init,
      signal: init?.signal ?? timeoutSignal(input.requestTimeoutMs),
    }),
  });
  const client = new Client({ name: "sps-mcp-connector", version: "0.1.0" });
  await client.connect(transport);

  return {
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        title: tool.title,
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(name, arguments_) {
      return client.callTool({ name, arguments: arguments_ });
    },
    async close() {
      await transport.close();
    },
  };
}
