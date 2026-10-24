import type { MarketplaceAssistantConfig } from "./marketplace-assistant-config.js";

export type MarketplaceAssistantToolName =
  | "search_marketplace_plugins"
  | "get_marketplace_plugin";

export class MarketplaceAssistantApiError extends Error {
  readonly status: number;

  constructor(status: number, detail = "") {
    super(`Marketplace Assistant request failed with status ${status}${detail ? ` (${detail})` : ""}`);
    this.name = "MarketplaceAssistantApiError";
    this.status = status;
  }
}

async function safeCoreErrorDetail(response: Response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) return "";
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const values = [payload?.code, payload?.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 160));
  return [...new Set(values)].join(": ").slice(0, 240);
}

export class MarketplaceAssistantClient {
  constructor(private readonly config: MarketplaceAssistantConfig) {}

  async executeTool(toolName: MarketplaceAssistantToolName, input: unknown): Promise<unknown> {
    const url = `${this.config.apiBaseUrl}/companies/${encodeURIComponent(this.config.companyId)}`
      + `/marketplace/assistant/tools/${encodeURIComponent(toolName)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.bearerToken}`,
        "X-Paperclip-Run-Id": this.config.runId,
      },
      body: JSON.stringify({ input }),
    });

    if (!response.ok) {
      throw new MarketplaceAssistantApiError(response.status, await safeCoreErrorDetail(response));
    }
    return response.json() as Promise<unknown>;
  }
}
