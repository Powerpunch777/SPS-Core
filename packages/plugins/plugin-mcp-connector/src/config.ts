export interface McpConnectorConfig {
  serverUrl: string;
  bearerTokenRef: string | null;
  allowedToolNames: string[];
  requestTimeoutMs: number;
}

export interface McpConnectorConfigValidation {
  config: McpConnectorConfig | null;
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function allowedToolNames(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(raw.flatMap((item) => {
    const normalized = stringValue(item);
    return normalized ? [normalized] : [];
  }))];
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function normalizeTimeout(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.trunc(parsed);
}

export function validateMcpConnectorConfig(raw: Record<string, unknown>): McpConnectorConfigValidation {
  const errors: string[] = [];
  const serverUrl = stringValue(raw.serverUrl);
  const toolNames = allowedToolNames(raw.allowedToolNames);
  const timeout = normalizeTimeout(raw.requestTimeoutMs);
  let parsedUrl: URL | null = null;

  if (!serverUrl) {
    errors.push("serverUrl is required.");
  } else {
    try {
      parsedUrl = new URL(serverUrl);
      if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLocalhost(parsedUrl))) {
        errors.push("serverUrl must use HTTPS unless it points at localhost.");
      }
    } catch {
      errors.push("serverUrl must be a valid absolute URL.");
    }
  }

  if (toolNames.length === 0) {
    errors.push("allowedToolNames must contain at least one exact remote tool name.");
  }
  if (toolNames.includes("*")) {
    errors.push("allowedToolNames must not contain a wildcard.");
  }
  if (timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    errors.push(`requestTimeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`);
  }

  if (errors.length > 0 || !parsedUrl) {
    return { config: null, errors };
  }

  return {
    config: {
      serverUrl: parsedUrl.toString(),
      bearerTokenRef: stringValue(raw.bearerToken),
      allowedToolNames: toolNames,
      requestTimeoutMs: timeout,
    },
    errors: [],
  };
}
