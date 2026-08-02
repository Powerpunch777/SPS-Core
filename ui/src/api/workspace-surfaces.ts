import type {
  PluginDashboardWidgetDeclaration,
  PluginDashboardWidgetSize,
  PluginInboxActionDeclaration,
  PluginWorkspaceShellDeclaration,
} from "@paperclipai/shared";
import { api } from "./client";

export type SpsWorkspaceShellProvider = {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  shell: PluginWorkspaceShellDeclaration;
};

export type SpsWorkspaceShellState = {
  mode: "neutral" | "plugin";
  providerPluginId: string | null;
  providerPluginKey: string | null;
  shell: PluginWorkspaceShellDeclaration | null;
  fallbackReason: string | null;
};

export type SpsDashboardWidget = {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  widget: PluginDashboardWidgetDeclaration;
  layout: {
    size: PluginDashboardWidgetSize;
    position: number;
    collapsed: boolean;
    source: "user" | "default";
  };
};

export type SpsDashboardLayoutItem = {
  pluginId: string;
  widgetId: string;
  size: PluginDashboardWidgetSize;
  position: number;
  collapsed?: boolean;
};

export type SpsWorkspaceInboxItem = {
  id: string;
  companyId: string;
  sourcePluginId: string | null;
  sourcePluginKey: string;
  sourcePluginDisplayName: string;
  externalId: string;
  targetUserId: string | null;
  category: string;
  severity: "info" | "success" | "warning" | "error";
  title: string;
  summary: string;
  navigationTarget: string | null;
  actionIds: string[];
  actions: SpsResolvedInboxAction[];
  opaqueReference: Record<string, unknown>;
  withdrawnAt: string | null;
  createdAt: string;
  updatedAt: string;
  unread: boolean;
  readAt: string | null;
  archivedAt: string | null;
};

export type SpsResolvedInboxAction = PluginInboxActionDeclaration;

export const workspaceSurfacesApi = {
  listShellProviders: (companyId: string) =>
    api.get<SpsWorkspaceShellProvider[]>(
      `/companies/${companyId}/workspace-shell/providers`,
    ),

  getShell: (companyId: string) =>
    api.get<SpsWorkspaceShellState>(`/companies/${companyId}/workspace-shell`),

  selectShell: (
    companyId: string,
    selection: { pluginId: string | null; shellId?: string | null },
  ) =>
    api.put<SpsWorkspaceShellState>(
      `/companies/${companyId}/workspace-shell`,
      selection,
    ),

  getDashboard: (companyId: string) =>
    api.get<{ widgets: SpsDashboardWidget[] }>(
      `/companies/${companyId}/workspace-dashboard`,
    ),

  saveDashboardLayout: (companyId: string, items: SpsDashboardLayoutItem[]) =>
    api.put<{ widgets: SpsDashboardWidget[] }>(
      `/companies/${companyId}/workspace-dashboard/layout`,
      { items },
    ),

  listInbox: (companyId: string, options: { archived?: boolean } = {}) =>
    api.get<{ items: SpsWorkspaceInboxItem[] }>(
      `/companies/${companyId}/workspace-inbox${options.archived ? "?archived=true" : ""}`,
    ),

  setInboxState: (
    companyId: string,
    itemId: string,
    state: { read?: boolean; archived?: boolean },
  ) =>
    api.patch<{ readAt: string | null; archivedAt: string | null }>(
      `/companies/${companyId}/workspace-inbox/${itemId}`,
      state,
    ),

  performInboxAction: (
    companyId: string,
    itemId: string,
    actionId: string,
  ) =>
    api.post<{ data: unknown }>(
      `/companies/${companyId}/workspace-inbox/${itemId}/actions/${encodeURIComponent(actionId)}`,
      {},
    ),
};
