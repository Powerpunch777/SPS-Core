export interface SpsMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  legacyToolNames?: boolean;
}

/** @deprecated Use SpsMcpConfig. */
export type PaperclipMcpConfig = SpsMcpConfig;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function readSpsOrLegacy(env: NodeJS.ProcessEnv, spsKey: string, legacyKey: string): string | null {
  return nonEmpty(env[spsKey]) ?? nonEmpty(env[legacyKey]);
}

function parseBoolean(value: string | null): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function readSpsMcpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SpsMcpConfig {
  const apiUrl = readSpsOrLegacy(env, "SPS_API_URL", "PAPERCLIP_API_URL");
  if (!apiUrl) {
    throw new Error("Missing SPS_API_URL");
  }
  const apiKey = readSpsOrLegacy(env, "SPS_API_KEY", "PAPERCLIP_API_KEY");
  if (!apiKey) {
    throw new Error("Missing SPS_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: readSpsOrLegacy(env, "SPS_COMPANY_ID", "PAPERCLIP_COMPANY_ID"),
    agentId: readSpsOrLegacy(env, "SPS_AGENT_ID", "PAPERCLIP_AGENT_ID"),
    runId: readSpsOrLegacy(env, "SPS_RUN_ID", "PAPERCLIP_RUN_ID"),
    legacyToolNames: parseBoolean(readSpsOrLegacy(env, "SPS_MCP_LEGACY_TOOL_NAMES", "PAPERCLIP_MCP_LEGACY_TOOL_NAMES")),
  };
}

/** @deprecated Use readSpsMcpConfigFromEnv. */
export const readConfigFromEnv = readSpsMcpConfigFromEnv;
