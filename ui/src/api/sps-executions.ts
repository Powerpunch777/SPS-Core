import type { PluginSpsExecutionSummary } from "@/compat/paperclip/plugin-sdk";
import { api } from "./client";

export interface SpsExecutionSummaryQuery {
  from: string;
  to: string;
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
};
