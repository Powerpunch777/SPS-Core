export interface MarketplaceAssistantConfig {
  apiBaseUrl: string;
  bearerToken: string;
  runId: string;
  companyId: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SPS_API_BASE_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SPS_API_BASE_URL must use http or https");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api") ? path : `${path}/api`;
  return url.toString().replace(/\/$/, "");
}

export function readMarketplaceAssistantConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MarketplaceAssistantConfig {
  return {
    apiBaseUrl: normalizeApiBaseUrl(required(env, "SPS_API_BASE_URL")),
    bearerToken: required(env, "SPS_SCOPED_BEARER_TOKEN"),
    runId: required(env, "SPS_RUN_ID"),
    companyId: required(env, "SPS_COMPANY_ID"),
  };
}
