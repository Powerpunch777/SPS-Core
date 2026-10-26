import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export function SpsCoreAgents() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const agents = (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Agents" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  return (
    <main data-sps-surface-owner="core" className="mx-auto w-full max-w-4xl space-y-4 px-1 py-2">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Agents
        </h1>
        {selectedCompanyId ? (
          <Button size="sm" asChild>
            <Link to="/assistants/new"><Plus className="h-4 w-4" aria-hidden="true" />Add Agent</Link>
          </Button>
        ) : null}
      </header>

      {!selectedCompanyId ? (
        <p className="text-sm text-muted-foreground">Choose a Workspace to view its Agents.</p>
      ) : agentsQuery.isPending ? (
        <p role="status" className="py-4 text-sm text-muted-foreground">Loading Agents...</p>
      ) : agentsQuery.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-4">
          <p role="alert" className="text-sm text-destructive">Agents could not be loaded. Try again.</p>
          <Button size="sm" variant="outline" disabled={agentsQuery.isFetching} onClick={() => void agentsQuery.refetch()}>
            {agentsQuery.isFetching ? "Retrying..." : "Retry"}
          </Button>
        </div>
      ) : agents.length === 0 ? (
        <div className="space-y-1 py-4">
          <p className="text-sm font-medium">No Agents yet</p>
          <p className="text-sm text-muted-foreground">Add an Agent to configure a runtime for this Workspace.</p>
        </div>
      ) : (
        <ul aria-label="Agents" className="divide-y divide-border">
          {agents.map((agent) => (
            <li key={agent.id} className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <Link
                to={`/assistants/${agent.id}`}
                className="min-w-0 break-words rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {agent.name}
              </Link>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                <AgentStatusBadge status={agent.status} />
                <span className="break-all text-xs text-muted-foreground">Adapter: {agent.adapterType}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
