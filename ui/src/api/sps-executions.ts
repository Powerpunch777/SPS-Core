import type {
  PluginSpsExecution,
  PluginSpsExecutionCursor,
  PluginSpsExecutionLane,
  PluginSpsExecutionPage,
  PluginSpsExecutionSummary,
} from "@/compat/paperclip/plugin-sdk";
import { api } from "./client";

export type {
  PluginSpsExecution,
  PluginSpsExecutionCursor,
  PluginSpsExecutionLane,
  PluginSpsExecutionPage,
};

export interface SpsExecutionSummaryQuery {
  from: string;
  to: string;
  signal?: AbortSignal;
}

export interface SpsExecutionListQuery {
  lane?: PluginSpsExecutionLane;
  limit?: number;
  cursor?: PluginSpsExecutionCursor | null;
  signal?: AbortSignal;
}

export const spsExecutionsApi = {
  summary(companyId: string, pluginId: string, query: SpsExecutionSummaryQuery) {
    const params = new URLSearchParams({
      pluginId,
      from: query.from,
      to: query.to,
    });
    return api.get<PluginSpsExecutionSummary>(
      `/companies/${encodeURIComponent(companyId)}/sps-executions/summary?${params.toString()}`,
      { signal: query.signal },
    );
  },

  list(companyId: string, pluginId: string, query: SpsExecutionListQuery = {}) {
    const params = new URLSearchParams({ pluginId, limit: String(query.limit ?? 20) });
    if (query.lane) params.set("lane", query.lane);
    if (query.cursor) {
      params.set("beforeCreatedAt", query.cursor.createdAt);
      params.set("beforeRunId", query.cursor.runId);
      params.set("beforeLane", query.cursor.lane);
    }
    return api.get<PluginSpsExecutionPage>(
      `/companies/${encodeURIComponent(companyId)}/sps-executions?${params.toString()}`,
      { signal: query.signal },
    );
  },

  get(
    companyId: string,
    pluginId: string,
    lane: PluginSpsExecutionLane,
    runId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    const params = new URLSearchParams({ pluginId });
    return api.get<PluginSpsExecution>(
      `/companies/${encodeURIComponent(companyId)}/sps-executions/${encodeURIComponent(lane)}/${encodeURIComponent(runId)}?${params.toString()}`,
      { signal: options.signal },
    );
  },
};
