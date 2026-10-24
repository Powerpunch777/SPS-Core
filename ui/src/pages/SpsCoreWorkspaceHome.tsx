import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Blocks,
  Bot,
  ChevronDown,
  ChevronUp,
  LayoutDashboard,
  Puzzle,
} from "lucide-react";
import type { PluginDashboardWidgetSize } from "../compat/paperclip/shared";
import { Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { pluginsApi } from "@/api/plugins";
import {
  workspaceSurfacesApi,
  type SpsDashboardLayoutItem,
  type SpsDashboardWidget,
} from "@/api/workspace-surfaces";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ensurePluginContributionLoaded,
  PluginDashboardWidgetMount,
} from "@/plugins/slots";

const sizeLabels: Record<PluginDashboardWidgetSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  full: "Full width",
};

function widgetColumnClass(size: PluginDashboardWidgetSize): string {
  switch (size) {
    case "small":
      return "lg:col-span-3";
    case "medium":
      return "lg:col-span-6";
    case "large":
      return "lg:col-span-9";
    case "full":
      return "lg:col-span-12";
  }
}

function layoutItems(widgets: SpsDashboardWidget[]): SpsDashboardLayoutItem[] {
  return [...widgets]
    .sort((left, right) => left.layout.position - right.layout.position)
    .map((entry, position) => ({
      pluginId: entry.pluginId,
      widgetId: entry.widget.id,
      size: entry.layout.size,
      position,
      collapsed: entry.layout.collapsed,
    }));
}

export function SpsCoreWorkspaceHome() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const {
    data: assistants,
    isLoading: assistantsLoading,
    error: assistantsError,
    refetch: refetchAssistants,
  } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: shell } = useQuery({
    queryKey: queryKeys.workspaceSurfaces.shell(selectedCompanyId ?? ""),
    queryFn: () => workspaceSurfacesApi.getShell(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const {
    data: dashboard,
    isLoading: dashboardLoading,
    error: dashboardError,
    refetch: refetchDashboard,
  } = useQuery({
    queryKey: queryKeys.workspaceSurfaces.dashboard(selectedCompanyId ?? ""),
    queryFn: () => workspaceSurfacesApi.getDashboard(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: contributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions(selectedCompanyId),
    queryFn: () => pluginsApi.listUiContributions(selectedCompanyId),
    enabled: Boolean(selectedCompanyId),
  });

  const contributionMap = useMemo(
    () => new Map((contributions ?? []).map((entry) => [entry.pluginId, entry])),
    [contributions],
  );
  const widgets = dashboard?.widgets ?? [];

  useEffect(() => {
    const required = [...new Set(widgets.map((widget) => widget.pluginId))]
      .map((pluginId) => contributionMap.get(pluginId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    for (const contribution of required) {
      void ensurePluginContributionLoaded(contribution);
    }
  }, [contributionMap, widgets]);

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Workspace" }]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const saveLayout = useMutation({
    mutationFn: (items: SpsDashboardLayoutItem[]) =>
      workspaceSurfacesApi.saveDashboardLayout(selectedCompanyId!, items),
    onSuccess: (next) => {
      queryClient.setQueryData(
        queryKeys.workspaceSurfaces.dashboard(selectedCompanyId!),
        next,
      );
    },
  });

  const activeAssistants = (assistants ?? []).filter((agent) => agent.status !== "terminated");

  function updateWidget(
    target: SpsDashboardWidget,
    patch: Partial<SpsDashboardLayoutItem>,
  ) {
    const items = layoutItems(widgets).map((item) => (
      item.pluginId === target.pluginId && item.widgetId === target.widget.id
        ? { ...item, ...patch }
        : item
    ));
    saveLayout.mutate(items);
  }

  function moveWidget(target: SpsDashboardWidget, direction: -1 | 1) {
    const items = layoutItems(widgets);
    const index = items.findIndex((item) => (
      item.pluginId === target.pluginId && item.widgetId === target.widget.id
    ));
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= items.length) return;
    [items[index], items[destination]] = [items[destination]!, items[index]!];
    saveLayout.mutate(items.map((item, position) => ({ ...item, position })));
  }

  return (
    <main data-sps-surface-owner="core" className="mx-auto w-full max-w-7xl space-y-6 px-1 py-2">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Blocks className="h-4 w-4" aria-hidden="true" />
            Workspace
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{selectedCompany?.name ?? "Workspace"}</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {shell?.mode === "plugin" && shell.shell
                ? `${shell.shell.displayName} is active in this Workspace.`
                : "Manage your Agents and open your enabled plugins."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/company/settings/instance/plugins">
              <Puzzle className="h-4 w-4" />
              Manage plugins
            </Link>
          </Button>
        </div>
      </header>

      {shell?.fallbackReason ? (
        <section className="flex items-start justify-between gap-4 rounded-md border border-amber-500/35 bg-amber-500/10 px-4 py-3">
          <div className="flex min-w-0 gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-medium">Default Workspace restored</p>
              <p className="text-sm text-muted-foreground">{shell.fallbackReason}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/company/settings/instance/plugins">Review plugins</Link>
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="core-attention-title">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 id="core-attention-title" className="text-sm font-semibold">Agents</h2>
            <p className="text-xs text-muted-foreground">Runtime, model, and default working folder settings.</p>
          </div>
        </div>
        <div className="rounded-md border border-border bg-card px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Link to="/company/settings/agents" className="text-sm font-medium hover:underline">Manage Agents</Link>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/assistants/new">Add Agent</Link>
            </Button>
          </div>
          {assistantsLoading ? (
            <p className="py-2 text-sm text-muted-foreground">Loading Agents...</p>
          ) : assistantsError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm text-destructive">
              Could not load Agents.
              <Button size="sm" variant="outline" onClick={() => void refetchAssistants()}>Retry Agents</Button>
            </div>
          ) : activeAssistants.length > 0 ? (
            <ul className="divide-y divide-border">
              {activeAssistants.map((assistant) => (
                <li key={assistant.id} className="flex min-w-0 flex-col gap-1 py-2 first:pt-1 last:pb-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <Link
                    className="min-w-0 truncate text-sm font-medium hover:underline"
                    to={`/assistants/${assistant.id}`}
                  >
                    {assistant.name}
                  </Link>
                  <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground sm:justify-end">
                    <span>Status: {assistant.status}</span>
                    <span>Adapter: {assistant.adapterType}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">No active Agents.</p>
          )}
        </div>
      </section>

      <section aria-labelledby="dashboard-widgets-title">
        <div className="mb-3">
          <h2 id="dashboard-widgets-title" className="flex items-center gap-2 text-sm font-semibold">
            <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
            Dashboard
          </h2>
          <p className="text-xs text-muted-foreground">Updates from your enabled plugins.</p>
        </div>

        {dashboardLoading ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            Loading Dashboard...
          </div>
        ) : dashboardError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Could not load Dashboard.
            <Button size="sm" variant="outline" onClick={() => void refetchDashboard()}>Retry Dashboard</Button>
          </div>
        ) : widgets.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <p className="text-sm font-medium">No plugin updates to show</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Open an enabled plugin from the sidebar, or manage plugins in Settings.
            </p>
            <Button className="mt-4" size="sm" asChild>
              <Link to={shell?.shell?.emptyWorkspaceAction?.target ?? "/company/settings/instance/plugins"}>
                {shell?.shell?.emptyWorkspaceAction?.displayName ?? "Open plugins"}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {widgets.map((entry, index) => {
              const contribution = contributionMap.get(entry.pluginId);
              return (
                <Card
                  key={`${entry.pluginId}:${entry.widget.id}`}
                  className={cn("min-w-0 py-0", widgetColumnClass(entry.layout.size))}
                >
                  <CardHeader className="flex-row items-start justify-between gap-3 border-b border-border/70">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-sm">{entry.widget.displayName}</CardTitle>
                      <CardDescription className="truncate text-xs">
                        {entry.widget.description || entry.pluginDisplayName}
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Select
                        value={entry.layout.size}
                        disabled={saveLayout.isPending}
                        onValueChange={(size) => updateWidget(entry, {
                          size: size as PluginDashboardWidgetSize,
                        })}
                      >
                        <SelectTrigger className="h-7 w-28 text-xs" aria-label={`Size for ${entry.widget.displayName}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {entry.widget.sizes.map((size) => (
                            <SelectItem key={size} value={size}>{sizeLabels[size]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === 0 || saveLayout.isPending}
                        aria-label={`Move ${entry.widget.displayName} up`}
                        title="Move up"
                        onClick={() => moveWidget(entry, -1)}
                      >
                        <ChevronUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={index === widgets.length - 1 || saveLayout.isPending}
                        aria-label={`Move ${entry.widget.displayName} down`}
                        title="Move down"
                        onClick={() => moveWidget(entry, 1)}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saveLayout.isPending}
                        onClick={() => updateWidget(entry, {
                          collapsed: !entry.layout.collapsed,
                        })}
                      >
                        {entry.layout.collapsed ? "Expand" : "Collapse"}
                      </Button>
                    </div>
                  </CardHeader>
                  {!entry.layout.collapsed ? (
                    <CardContent className="min-h-24">
                      {contribution ? (
                        <PluginDashboardWidgetMount
                          pluginId={entry.pluginId}
                          pluginKey={entry.pluginKey}
                          pluginDisplayName={entry.pluginDisplayName}
                          pluginVersion={contribution.version}
                          widget={entry.widget}
                          context={{
                            companyId: selectedCompanyId,
                            companyPrefix: selectedCompany?.issuePrefix ?? null,
                          }}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {entry.pluginDisplayName} UI is unavailable.
                        </p>
                      )}
                    </CardContent>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}

        {saveLayout.error ? (
          <p className="mt-3 text-sm text-destructive">
            Failed to save layout: {saveLayout.error instanceof Error ? saveLayout.error.message : "Unknown error"}
          </p>
        ) : null}
      </section>
    </main>
  );
}
