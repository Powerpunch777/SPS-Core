import {
  definePlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginToolDeclaration,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { validateMcpConnectorConfig, type McpConnectorConfig } from "./config.js";
import { connectRemoteMcp } from "./mcp-client.js";
import { defaultInputSchema, mapAllowedRemoteTools, type MappedMcpTool } from "./tool-mapping.js";

interface ConnectorHealth {
  toolCount: number;
  error: string | null;
}

let activeContext: PluginContext | null = null;
let health: ConnectorHealth = { toolCount: 0, error: "Connector is not configured." };

async function resolveBearerToken(ctx: PluginContext, config: McpConnectorConfig): Promise<string | null> {
  return config.bearerTokenRef ? ctx.secrets.resolve(config.bearerTokenRef) : null;
}

async function withConnection<T>(
  ctx: PluginContext,
  config: McpConnectorConfig,
  fn: (connection: Awaited<ReturnType<typeof connectRemoteMcp>>) => Promise<T>,
): Promise<T> {
  const connection = await connectRemoteMcp({
    serverUrl: config.serverUrl,
    bearerToken: await resolveBearerToken(ctx, config),
    http: ctx.http,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  try {
    return await fn(connection);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

function toToolResult(result: unknown): ToolResult {
  const data = result && typeof result === "object" ? result : { value: result };
  const content = typeof result === "object" && result && "content" in result
    ? JSON.stringify((result as { content: unknown }).content, null, 2)
    : JSON.stringify(result, null, 2);
  const isError = Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError);
  return isError ? { error: content, data } : { content, data };
}

function dynamicTool(
  ctx: PluginContext,
  config: McpConnectorConfig,
  mappedTool: MappedMcpTool,
) {
  const declaration: Pick<PluginToolDeclaration, "displayName" | "description" | "parametersSchema"> = {
    displayName: mappedTool.title ?? `MCP: ${mappedTool.name}`,
    description: mappedTool.description ?? `Call the remote MCP tool \`${mappedTool.name}\`.`,
    parametersSchema: defaultInputSchema(mappedTool.inputSchema),
  };
  return {
    name: mappedTool.spsToolName,
    declaration,
    async fn(params: unknown): Promise<ToolResult> {
      const arguments_ = params && typeof params === "object" && !Array.isArray(params)
        ? params as Record<string, unknown>
        : {};
      const result = await withConnection(ctx, config, (connection) => connection.callTool(mappedTool.name, arguments_));
      return toToolResult(result);
    },
  };
}

async function refreshRemoteTools(ctx: PluginContext, rawConfig: Record<string, unknown>): Promise<void> {
  const validated = validateMcpConnectorConfig(rawConfig);
  if (!validated.config) {
    await ctx.tools.replaceDynamic([]);
    health = { toolCount: 0, error: validated.errors.join(" ") };
    ctx.logger.warn("Remote MCP Connector configuration is invalid", { errors: validated.errors });
    return;
  }

  try {
    const remoteTools = await withConnection(ctx, validated.config, (connection) => connection.listTools());
    const mapped = mapAllowedRemoteTools(remoteTools, validated.config.allowedToolNames);
    const registration = await ctx.tools.replaceDynamic(
      mapped.map((tool) => dynamicTool(ctx, validated.config!, tool)),
    );
    health = { toolCount: registration.registered, error: null };
    ctx.logger.info("Remote MCP tools refreshed", {
      configured: validated.config.allowedToolNames.length,
      discovered: remoteTools.length,
      registered: registration.registered,
    });
  } catch (error) {
    await ctx.tools.replaceDynamic([]);
    health = {
      toolCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    ctx.logger.error("Remote MCP tool discovery failed", { error: health.error });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    await refreshRemoteTools(ctx, await ctx.config.get());
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    if (health.error) return { status: "degraded", message: health.error, details: { toolCount: health.toolCount } };
    return {
      status: "ok",
      message: `Remote MCP Connector ready with ${health.toolCount} allowlisted tools.`,
      details: { toolCount: health.toolCount },
    };
  },

  async onValidateConfig(config) {
    const result = validateMcpConnectorConfig(config);
    return result.config ? { ok: true, normalizedConfig: result.config } : { ok: false, errors: result.errors };
  },

  async onConfigChanged(newConfig) {
    if (!activeContext) throw new Error("Remote MCP Connector has not been initialized.");
    await refreshRemoteTools(activeContext, newConfig);
  },

  async onShutdown() {
    if (activeContext) await activeContext.tools.replaceDynamic([]);
    health = { toolCount: 0, error: "Connector stopped." };
    activeContext = null;
  },
});

export default plugin;
