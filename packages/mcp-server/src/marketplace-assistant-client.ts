import type { MarketplaceAssistantConfig } from "./marketplace-assistant-config.js";

export type MarketplaceAssistantToolName =
  | "search_marketplace_plugins"
  | "get_marketplace_plugin";

export class MarketplaceAssistantApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Marketplace Assistant request failed with status ${status}`);
    this.name = "MarketplaceAssistantApiError";
    this.status = status;
  }
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

    if (!response.ok) throw new MarketplaceAssistantApiError(response.status);
    return response.json() as Promise<unknown>;
  }
}
