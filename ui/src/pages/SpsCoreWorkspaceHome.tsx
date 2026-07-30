import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, Bot, Puzzle, Settings2 } from "lucide-react";
import { Link, Navigate } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { pluginsApi } from "@/api/plugins";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function SpsCoreWorkspaceHome() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { data: companyPlugins, isLoading } = useQuery({
    queryKey: queryKeys.plugins.companyActivation(selectedCompanyId ?? ""),
    queryFn: () => pluginsApi.listForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const {
    data: assistants,
    isLoading: assistantsLoading,
    isSuccess: assistantsLoaded,
  } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Workspace" }]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const enabledPlugins = (companyPlugins?.plugins ?? []).filter(
    (plugin) => plugin.status === "ready" && plugin.activation.enabled,
  );
  const initialAssistant = (assistants ?? []).find((agent) => agent.status !== "terminated") ?? null;

  if (assistantsLoaded && !initialAssistant) {
    return <Navigate to="/assistants/new" replace />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 py-2">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Blocks className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{selectedCompany?.name ?? "Workspace"}</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          This Workspace has no built-in task or role model. Enable a plugin to add the workflow your team needs.
        </p>
      </div>

      <Card className="py-0">
        <CardHeader className="gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><Bot className="h-4 w-4" />Initial Assistant</CardTitle>
          <CardDescription>
            This runtime answers in Plugin Discovery & Builder. It has no built-in team role or workflow authority.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          {assistantsLoading ? <p className="text-sm text-muted-foreground">Loading Assistant...</p> : null}
          {!assistantsLoading && initialAssistant ? (
            <div className="min-w-0">
              <Link className="truncate text-sm font-medium hover:underline" to={`/assistants/${initialAssistant.id}`}>
                {initialAssistant.name}
              </Link>
              <p className="truncate text-xs text-muted-foreground">{initialAssistant.title || initialAssistant.adapterType}</p>
            </div>
          ) : null}
          <Button size="sm" asChild>
            <Link to={initialAssistant ? "/discover" : "/assistants/new"}>{initialAssistant ? "Open Discovery" : "Add Assistant"}</Link>
          </Button>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><Puzzle className="h-4 w-4" />Enabled plugins</CardTitle>
          <CardDescription>
            Plugin Discovery & Builder can recommend or draft a plugin. It never changes plugin state from a conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading plugins...</p> : null}
          {!isLoading && enabledPlugins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No plugins are enabled for this Workspace.</p>
          ) : null}
          {enabledPlugins.map((plugin) => (
            <div key={plugin.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{plugin.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{plugin.pluginKey}</p>
              </div>
              <span className="shrink-0 text-xs text-emerald-700 dark:text-emerald-300">Ready</span>
            </div>
          ))}
          <Button size="sm" variant="outline" asChild>
            <Link to="/company/settings/instance/plugins"><Settings2 className="mr-1.5 h-3.5 w-3.5" />Manage plugins</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
