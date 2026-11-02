import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";

export interface PluginSessionToolsConfig {
  apiBaseUrl: string;
  bearerToken: string;
  runId: string;
  companyId: string;
  agentId: string;
  pluginKey: string;
}

export interface PluginSessionToolsClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const PLUGIN_SESSION_TOOLS_TIMEOUT_MS = 10_000;

const listInput = z.object({}).strict();
const executeInput = z.object({
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
}).strict();

export class PluginSessionToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSessionToolsError";
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginSessionToolsError(`Missing ${name}`);
  }
  return value.trim();
}

function normalizeApiBaseUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PluginSessionToolsError("SPS_API_BASE_URL must be an absolute local loopback HTTP URL");
  }

  const authority = /^http:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  const rawHost = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1).toLowerCase()
    : authority.split(":", 1)[0].toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:"
    || !loopbackHosts.has(rawHost)
    || authority.includes("@")
    || Boolean(url.username || url.password)
    || raw.includes("?")
    || raw.includes("#")
  ) {
    throw new PluginSessionToolsError(
      "SPS_API_BASE_URL must use local loopback HTTP without credentials, query, or fragment",
    );
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/api") ? pathname : `${pathname}/api`;
  return url.toString().replace(/\/$/, "");
}

function normalizeConfig(config: PluginSessionToolsConfig): PluginSessionToolsConfig {
  return {
    apiBaseUrl: normalizeApiBaseUrl(required(config.apiBaseUrl, "SPS_API_BASE_URL")),
    bearerToken: required(config.bearerToken, "SPS_SCOPED_BEARER_TOKEN"),
    runId: required(config.runId, "SPS_RUN_ID"),
    companyId: required(config.companyId, "SPS_COMPANY_ID"),
    agentId: required(config.agentId, "SPS_AGENT_ID"),
    pluginKey: required(config.pluginKey, "SPS_PLUGIN_KEY"),
  };
}

export function readPluginSessionToolsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PluginSessionToolsConfig {
  return normalizeConfig({
    apiBaseUrl: env.SPS_API_BASE_URL ?? "",
    bearerToken: env.SPS_SCOPED_BEARER_TOKEN ?? "",
    runId: env.SPS_RUN_ID ?? "",
    companyId: env.SPS_COMPANY_ID ?? "",
    agentId: env.SPS_AGENT_ID ?? "",
    pluginKey: env.SPS_PLUGIN_KEY ?? "",
  });
}

export class PluginSessionToolsClient {
  private readonly config: PluginSessionToolsConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: PluginSessionToolsConfig, options: PluginSessionToolsClientOptions = {}) {
    this.config = normalizeConfig(config);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? PLUGIN_SESSION_TOOLS_TIMEOUT_MS;
    if (
      !Number.isFinite(this.timeoutMs)
      || this.timeoutMs <= 0
      || this.timeoutMs > PLUGIN_SESSION_TOOLS_TIMEOUT_MS
    ) {
      throw new PluginSessionToolsError(
        `Plugin tools request timeout must be between 1 and ${PLUGIN_SESSION_TOOLS_TIMEOUT_MS} ms`,
      );
    }
  }

  async listPluginTools(): Promise<Record<string, unknown>[]> {
    const url = new URL("plugins/tools", `${this.config.apiBaseUrl}/`);
    url.searchParams.set("pluginId", this.config.pluginKey);
    const payload = await this.requestJson(url, { method: "GET" });
    if (!Array.isArray(payload)) {
      throw new PluginSessionToolsError("Plugin tools API returned an invalid tool list");
    }

    const prefix = `${this.config.pluginKey}:`;
    return payload.filter((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const descriptor = entry as Record<string, unknown>;
      // The retained API's pluginId is a database UUID, not the public key.
      // The dispatcher binds that key in the canonical namespaced tool name.
      return typeof descriptor.name === "string"
        && descriptor.name.startsWith(prefix)
        && descriptor.name.length > prefix.length;
    });
  }

  async executePluginTool(toolName: string, parameters: Record<string, unknown>): Promise<unknown> {
    const prefix = `${this.config.pluginKey}:`;
    if (!toolName.startsWith(prefix) || toolName.length <= prefix.length) {
      throw new PluginSessionToolsError("Tool name is outside the configured plugin namespace");
    }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new PluginSessionToolsError("Tool parameters must be an object");
    }

    return this.requestJson(new URL("plugins/tools/execute", `${this.config.apiBaseUrl}/`), {
      method: "POST",
      body: JSON.stringify({
        tool: toolName,
        parameters,
        runContext: {
          agentId: this.config.agentId,
          runId: this.config.runId,
          companyId: this.config.companyId,
        },
      }),
    });
  }

  private async requestJson(url: URL, request: { method: "GET" | "POST"; body?: string }): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.bearerToken}`,
          "X-Paperclip-Run-Id": this.config.runId,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new PluginSessionToolsError(`Plugin tools API request failed with HTTP ${response.status}`);
      }
      try {
        return await response.json() as unknown;
      } catch {
        if (timedOut) throw new PluginSessionToolsError("Plugin tools API request timed out");
        throw new PluginSessionToolsError("Plugin tools API returned invalid JSON");
      }
    } catch (error) {
      if (timedOut) throw new PluginSessionToolsError("Plugin tools API request timed out");
      if (error instanceof PluginSessionToolsError) throw error;
      throw new PluginSessionToolsError("Plugin tools API request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeError(error: unknown) {
  const message = error instanceof PluginSessionToolsError
    ? error.message
    : "Plugin tools request failed";
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function toolResultContent(result: unknown) {
  const hasError = Boolean(result && typeof result === "object" && (
    ("error" in result && (result as { error?: unknown }).error)
    || (
      "result" in result
      && result.result !== null
      && typeof result.result === "object"
      && "error" in result.result
      && (result.result as { error?: unknown }).error
    )
  ));
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) ?? "null" }],
    ...(hasError ? { isError: true } : {}),
  };
}

export function createPluginSessionToolsServer(
  config: PluginSessionToolsConfig,
  options: PluginSessionToolsClientOptions = {},
) {
  const server = new McpServer({ name: "sps-plugin-session-tools", version: "0.1.0" });
  const client = new PluginSessionToolsClient(config, options);

  server.registerTool("list_plugin_tools", {
    description: "List tools exposed by this plugin for the current authenticated Agent run.",
    inputSchema: listInput.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await client.listPluginTools()) }] };
    } catch (error) {
      return safeError(error);
    }
  });

  server.registerTool("execute_plugin_tool", {
    description: "Execute a tool belonging to this plugin using the current authenticated Agent run.",
    inputSchema: executeInput.shape,
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (input) => {
    try {
      return toolResultContent(await client.executePluginTool(input.toolName, input.parameters));
    } catch (error) {
      return safeError(error);
    }
  });

  return { server, client };
}
