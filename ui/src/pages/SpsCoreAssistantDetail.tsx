import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { AgentConfigForm } from "@/components/AgentConfigForm";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link, Navigate, useParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export function SpsCoreAssistantDetail() {
  const { agentId } = useParams<{ agentId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const assistantRef = agentId ?? "";

  const { data: assistant, isLoading, error, refetch } = useQuery({
    queryKey: [...queryKeys.agents.detail(assistantRef), selectedCompanyId],
    queryFn: () => agentsApi.get(assistantRef, selectedCompanyId ?? undefined),
    enabled: Boolean(assistantRef && selectedCompanyId),
  });

  const updateAssistant = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      agentsApi.update(assistantRef, patch, selectedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(assistantRef) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/company/settings/agents" },
      { label: assistant?.name ?? "Agent settings" },
    ]);
  }, [assistant?.name, setBreadcrumbs]);

  if (!agentId) return <Navigate to="/company/settings/agents" replace />;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading Agent...</p>;
  if (error || !assistant) return <div role="alert" className="space-y-3 text-sm">
    <p className="text-destructive">Could not load this Agent.</p>
    <Button variant="outline" onClick={() => void refetch()}>Retry</Button>
    <Button variant="ghost" asChild><Link to="/company/settings/agents">Back to Agents</Link></Button>
  </div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link to="/company/settings/agents"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Agents</Link>
          </Button>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted/40">
              <Bot className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold">{assistant.name}</h1>
              <p className="truncate text-sm text-muted-foreground">
                {assistant.title || "Agent"} · {assistant.adapterType} · {assistant.status}
              </p>
            </div>
          </div>
        </div>
        <Button size="sm" asChild><Link to="/company/settings/instance/plugins">Open Plugins</Link></Button>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium">Runtime configuration</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Set this Agent's runtime, model, and default working folder. Plugins choose how to use the Agent.
          </p>
        </div>
        <AgentConfigForm
          key={`${selectedCompanyId}:${assistant.id}`}
          mode="edit"
          agent={assistant}
          onSave={(patch) => updateAssistant.mutateAsync(patch)}
          isSaving={updateAssistant.isPending}
          showCreateRunPolicySection={false}
          hideWorkflowIdentityFields
          showDefaultWorkingDirectory
          hidePromptTemplate
          sectionLayout="cards"
        />
        {updateAssistant.isError ? (
          <p className="text-sm text-destructive">
            {updateAssistant.error instanceof Error ? updateAssistant.error.message : "Agent update failed."}
          </p>
        ) : null}
      </section>
    </div>
  );
}
