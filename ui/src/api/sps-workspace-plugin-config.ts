import { api, type RequestOptions } from "./client";

export interface SpsWorkspacePluginRuntimeConfigRecord {
  workspaceId: string;
  pluginId: string;
  configJson: Record<string, unknown>;
  revision: string | null;
  updatedAt: string | null;
}

export interface SpsWorkspacePluginRuntimeConfigUpdate {
  configJson: Record<string, unknown>;
  expectedRevision: string | null;
}

function endpoint(pluginId: string, workspaceId: string) {
  return `/plugins/${encodeURIComponent(pluginId)}/companies/${encodeURIComponent(workspaceId)}/workspace-runtime-config`;
}

/** Workspace-scoped plugin runtime configuration, stored and enforced by the SPS Host. */
export const spsWorkspacePluginConfigApi = {
  get: (pluginId: string, workspaceId: string, options?: RequestOptions) =>
    api.get<SpsWorkspacePluginRuntimeConfigRecord>(endpoint(pluginId, workspaceId), options),

  put: (pluginId: string, workspaceId: string, update: SpsWorkspacePluginRuntimeConfigUpdate) =>
    api.put<SpsWorkspacePluginRuntimeConfigRecord>(endpoint(pluginId, workspaceId), update),

  reset: (pluginId: string, workspaceId: string, expectedRevision: string | null) =>
    api.deleteWithBody<SpsWorkspacePluginRuntimeConfigRecord>(
      endpoint(pluginId, workspaceId),
      { expectedRevision },
    ),
};
