import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, Bot } from "lucide-react";
import { Link, Navigate } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function SpsCoreWorkspaceHome() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    data: assistants,
    isLoading: assistantsLoading,
    isSuccess: assistantsLoaded,
    isFetching: assistantsFetching,
  } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: selectedCompany?.name ?? "Workspace" }]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const initialAssistant = (assistants ?? []).find((agent) => agent.status !== "terminated") ?? null;

  // Keep the setup route stable while a just-created Assistant replaces the
  // cached empty list. Redirecting during that refetch reopens setup forever.
  if (assistantsLoaded && !assistantsFetching && !initialAssistant) {
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
            <Link to={initialAssistant ? "/company/settings/instance/plugins" : "/assistants/new"}>{initialAssistant ? "Open Plugins" : "Add Assistant"}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
