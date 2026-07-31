import { api } from "./client";

export interface SpsMarketplaceCompatibility {
  sps: string | null;
  pluginApi: number | null;
  extensionProfile: string | null;
}

export interface SpsMarketplacePluginSummary {
  pluginId: string;
  displayName: string;
  version: string;
  summary: string;
  categories: string[];
  capabilities: string[];
  publisher: string;
  compatibility: SpsMarketplaceCompatibility;
  trust: "official" | "verified" | "local";
}

export interface SpsMarketplacePluginDetail extends SpsMarketplacePluginSummary {
  description: string;
  documentationUrl: string | null;
}

export interface SpsMarketplaceListResponse {
  plugins: SpsMarketplacePluginSummary[];
  total: number;
  source: { id: string; displayName: string } | null;
  refreshedAt: string | null;
}

function searchParams(input: { query?: string; category?: string; capability?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (input.query?.trim()) params.set("q", input.query.trim());
  if (input.category?.trim()) params.set("category", input.category.trim());
  if (input.capability?.trim()) params.set("capability", input.capability.trim());
  if (input.limit) params.set("limit", String(input.limit));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export const spsMarketplaceApi = {
  list: (companyId: string, input: { query?: string; category?: string; capability?: string; limit?: number } = {}) =>
    api.get<SpsMarketplaceListResponse>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/plugins${searchParams(input)}`,
    ),
  get: (companyId: string, pluginId: string) =>
    api.get<{ plugin: SpsMarketplacePluginDetail }>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/plugins/${encodeURIComponent(pluginId)}`,
    ),
};
