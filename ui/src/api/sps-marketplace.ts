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

export interface SpsMarketplaceAssistantAgent {
  id: string;
  name: string;
  title: string | null;
  icon: string | null;
  adapterType: string;
  status: string;
}

export interface SpsMarketplaceAssistantSession {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionDisplayId: string | null;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface SpsMarketplaceAssistantMessage {
  id: string;
  sessionId: string;
  runId: string;
  idempotencyKey: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SpsMarketplaceAssistantMessagesResponse {
  messages: SpsMarketplaceAssistantMessage[];
  nextCursor: string | null;
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
  listAssistantAgents: (companyId: string) =>
    api.get<{ agents: SpsMarketplaceAssistantAgent[] }>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/assistant/agents`,
    ),
  openAssistantSession: (companyId: string, agentId: string) =>
    api.post<{ session: SpsMarketplaceAssistantSession }>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/assistant/sessions`,
      { agentId },
    ),
  listAssistantMessages: (companyId: string, sessionId: string, after?: string) =>
    api.get<SpsMarketplaceAssistantMessagesResponse>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/assistant/sessions/${encodeURIComponent(sessionId)}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`,
    ),
  sendAssistantMessage: (companyId: string, sessionId: string, content: string, idempotencyKey: string) =>
    api.post<{ message: SpsMarketplaceAssistantMessage; run: { id: string; status: string } }>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/assistant/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content, idempotencyKey },
    ),
  closeAssistantSession: (companyId: string, sessionId: string) =>
    api.post<{ session: SpsMarketplaceAssistantSession }>(
      `/companies/${encodeURIComponent(companyId)}/marketplace/assistant/sessions/${encodeURIComponent(sessionId)}/close`,
      {},
    ),
};
