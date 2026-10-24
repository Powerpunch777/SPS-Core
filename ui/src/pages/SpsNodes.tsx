import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isAgentStatusAssignableToWork,
  spsNodeCapabilityForAdapter,
  type Agent,
} from "../compat/paperclip/shared";
import {
  CheckCircle2,
  CirclePause,
  Cpu,
  Link2,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Unlink,
  XCircle,
} from "lucide-react";
import { agentsApi } from "@/api/agents";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";
import { spsNodesApi, type SpsNode } from "@/api/spsNodes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";

function nodeStatusBadge(status: SpsNode["status"]) {
  if (status === "active") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Active</Badge>;
  if (status === "pending") return <Badge variant="outline">Pending approval</Badge>;
  return <Badge variant="destructive">Revoked</Badge>;
}

function runnerAvailabilityBadge(status: SpsNode["runners"][number]["availabilityStatus"]) {
  if (status === "available") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Available</Badge>;
  if (status === "busy") return <Badge className="bg-amber-600 text-white hover:bg-amber-600">Busy</Badge>;
  if (status === "quota_limited") return <Badge variant="destructive">Quota limited</Badge>;
  if (status === "auth_required") return <Badge variant="destructive">Sign-in required</Badge>;
  if (status === "offline") return <Badge variant="outline">Offline</Badge>;
  return <Badge variant="outline">Status unknown</Badge>;
}

function agentLabel(agent: Pick<Agent, "name" | "title" | "role">) {
  return agent.title?.trim() || `${agent.name} (${agent.role})`;
}

function nodeSupportsAgent(node: SpsNode, agent: Agent) {
  const capabilityKind = spsNodeCapabilityForAdapter(agent.adapterType);
  return capabilityKind !== null && node.capabilities.some((capability) => capability.kind === capabilityKind);
}

function nodeIsOnline(lastSeenAt: string | null) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() <= 2 * 60 * 1000;
}

function errorMessage(error: unknown, spsCoreBaseline: boolean) {
  if (error instanceof ApiError && error.status === 403) {
    return spsCoreBaseline
      ? "Only the SPS Host can manage shared Nodes."
      : "Only company owners and admins can manage SPS Nodes.";
  }
  return error instanceof Error ? error.message : "Unknown error";
}

export function canManageSpsNodes(
  companyId: string | null,
  access: CurrentBoardAccess | undefined,
  spsCoreBaseline: boolean,
) {
  if (!companyId || !access) return null;
  if (spsCoreBaseline) return access.isCoreHost === true || access.source === "local_implicit";
  if (access.isInstanceAdmin || access.source === "local_implicit") return true;
  const membership = access.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return membership?.membershipRole === "owner" || membership?.membershipRole === "admin";
}

export function SpsNodes() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const spsCoreBaseline = isSpsCoreBaselineModeEnabled();
  const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});

  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const canManageNodes = canManageSpsNodes(selectedCompanyId, boardAccessQuery.data, spsCoreBaseline);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? (spsCoreBaseline ? "Workspace" : "Company"), href: "/dashboard" },
      { label: spsCoreBaseline ? "Host settings" : "Settings", href: "/company/settings" },
      { label: "Nodes" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, spsCoreBaseline]);

  const nodesQuery = useQuery({
    queryKey: queryKeys.spsNodes.list(selectedCompanyId ?? ""),
    queryFn: () => spsNodesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && canManageNodes === true,
    refetchInterval: 15_000,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && canManageNodes === true,
  });

  const refreshNodes = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.spsNodes.list(selectedCompanyId) });
  };

  const approveMutation = useMutation({
    mutationFn: (nodeId: string) => spsNodesApi.approve(nodeId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({ title: "SPS Node approved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not approve SPS Node", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });
  const revokeMutation = useMutation({
    mutationFn: (nodeId: string) => spsNodesApi.revoke(nodeId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({ title: "SPS Node revoked", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not revoke SPS Node", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });
  const grantMutation = useMutation({
    mutationFn: (input: { nodeId: string; agentId: string }) => spsNodesApi.grantAgent(input.nodeId, input.agentId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({
        title: "Agent access granted",
        body: "The first approved Node for an Agent becomes its primary execution Node. Later grants keep the current primary until you change it.",
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not grant Agent access", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });
  const revokeGrantMutation = useMutation({
    mutationFn: (input: { nodeId: string; agentId: string }) => spsNodesApi.revokeAgent(input.nodeId, input.agentId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({ title: "Agent access removed", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not remove Agent access", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });
  const bindMutation = useMutation({
    mutationFn: (input: { nodeId: string; agentId: string }) => spsNodesApi.bindPrimary(input.agentId, input.nodeId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({ title: "Primary execution Node updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not set primary Node", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });
  const clearBindingMutation = useMutation({
    mutationFn: (agentId: string) => spsNodesApi.clearPrimary(agentId),
    onSuccess: async () => {
      await refreshNodes();
      pushToast({ title: "Primary execution Node cleared", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not clear primary Node", body: errorMessage(error, spsCoreBaseline), tone: "error" }),
  });

  const activeAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => isAgentStatusAssignableToWork(agent.status)),
    [agentsQuery.data],
  );

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a {spsCoreBaseline ? "Workspace" : "company"} to manage SPS Nodes.</div>;
  }
  if (boardAccessQuery.error) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">Could not check SPS Node access: {errorMessage(boardAccessQuery.error, spsCoreBaseline)}</p>
        <Button variant="outline" size="sm" onClick={() => void boardAccessQuery.refetch()} disabled={boardAccessQuery.isFetching}>
          <RefreshCw className="mr-1.5 h-4 w-4" />Retry access
        </Button>
      </div>
    );
  }
  if (boardAccessQuery.isLoading || canManageNodes === null) {
    return <div className="text-sm text-muted-foreground">Checking SPS Node access...</div>;
  }
  if (canManageNodes === false) {
    return (
      <div className="max-w-2xl space-y-4">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <MonitorCog className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">SPS Nodes</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {spsCoreBaseline
              ? "Only the Host manages the shared computer inventory from this page."
              : "SPS Nodes are approved and assigned by company Owners or Admins. Team members do not manage the shared computer inventory from this page."}
          </p>
        </header>
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Open SPS Desktop on this computer and choose <strong>Connect this computer as an SPS Node</strong>. {spsCoreBaseline
            ? "The Host will then see it as pending approval."
            : "The Owner will then see it as pending approval and can grant it to specific Agents."}
        </div>
      </div>
    );
  }
  if (nodesQuery.isLoading || agentsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading SPS Nodes...</div>;
  }
  if (nodesQuery.error) {
    return <div className="text-sm text-destructive">{errorMessage(nodesQuery.error, spsCoreBaseline)}</div>;
  }

  const nodes = nodesQuery.data ?? [];
  const isMutating = approveMutation.isPending
    || revokeMutation.isPending
    || grantMutation.isPending
    || revokeGrantMutation.isPending
    || bindMutation.isPending
    || clearBindingMutation.isPending;

  return (
    <div className="max-w-6xl space-y-8">
      <header className="space-y-3">
        <div className="flex items-center gap-2">
          <MonitorCog className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">SPS Nodes</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Approve computers registered by SPS Desktop. Runner profiles show safe runtime readiness and quota evidence without exposing local credentials.
        </p>
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>The SPS team Host stores only a Node&apos;s public capabilities. CLI credentials, API keys, project files, and local paths remain on the Node computer.</span>
        </div>
      </header>

      {nodes.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">
          No computers are registered yet. Open the SPS Desktop invitation link on the computer you want to connect, then complete the sign-in flow.
        </section>
      ) : (
        <div className="space-y-4">
          {nodes.map((node) => {
            const grantedAgentIds = new Set(node.agentGrants.map((grant) => grant.agentId));
            const availableAgents = activeAgents.filter(
              (agent) => !grantedAgentIds.has(agent.id) && nodeSupportsAgent(node, agent),
            );
            const selectedAgentId = agentDrafts[node.id] ?? "";
            const isOnline = node.status === "active" && nodeIsOnline(node.lastSeenAt);

            return (
              <section key={node.id} className="rounded-lg border border-border bg-background">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{node.displayName}</h2>
                      {nodeStatusBadge(node.status)}
                      {node.keyVerifiedAt ? (
                        <Badge variant="outline" className="border-emerald-500/50 text-emerald-700">Key verified</Badge>
                      ) : (
                        <Badge variant="outline">Awaiting signed heartbeat</Badge>
                      )}
                      {node.status === "active" ? (
                        <Badge variant="outline" className={isOnline ? "border-emerald-500/50 text-emerald-700" : "border-amber-500/50 text-amber-700"}>
                          {isOnline ? "Online" : "Offline"}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {node.platform}{node.appVersion ? ` - SPS ${node.appVersion}` : ""}
                      {node.lastSeenAt ? ` - Last seen ${new Date(node.lastSeenAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {node.status === "pending" ? (
                      <Button
                        size="sm"
                        onClick={() => approveMutation.mutate(node.id)}
                        disabled={isMutating || !node.keyVerifiedAt}
                      >
                        <CheckCircle2 className="mr-1.5 h-4 w-4" />Approve
                      </Button>
                    ) : null}
                    {node.status === "active" ? (
                      <Button size="sm" variant="outline" onClick={() => revokeMutation.mutate(node.id)} disabled={isMutating}>
                        <XCircle className="mr-1.5 h-4 w-4" />Revoke
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-5 px-5 py-5">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium"><Cpu className="h-4 w-4 text-muted-foreground" />Available runtimes</div>
                    <div className="flex flex-wrap gap-2">
                      {node.capabilities.length > 0 ? node.capabilities.map((capability) => (
                        <Badge key={`${capability.kind}:${capability.label}`} variant="outline">
                          {capability.label}{capability.models?.length ? `: ${capability.models.join(", ")}` : ""}
                        </Badge>
                      )) : <span className="text-sm text-muted-foreground">No runtime capabilities were published.</span>}
                    </div>
                  </div>

                  <div className="space-y-2 border-t border-border pt-5">
                    <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-muted-foreground" />Runner profiles</div>
                    {node.runners.length > 0 ? (
                      <div className="divide-y divide-border rounded-md border border-border">
                        {node.runners.map((runner) => (
                          <div key={runner.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                <span>{runner.label}</span>
                                {runner.profileLabel ? <Badge variant="outline">{runner.profileLabel}</Badge> : null}
                                {runner.credentialStatus === "ready" ? <Badge variant="outline" className="border-emerald-500/50 text-emerald-700">Local sign-in ready</Badge> : null}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {runner.availabilityObservedAt
                                  ? `Reported ${new Date(runner.availabilityObservedAt).toLocaleString()} via ${runner.availabilitySource}`
                                  : "This Node has not reported Runner availability yet."}
                                {runner.retryAfter ? ` - Retry after ${new Date(runner.retryAfter).toLocaleString()}` : ""}
                              </p>
                              {runner.availabilityDetail ? <p className="mt-1 text-xs text-muted-foreground">{runner.availabilityDetail}</p> : null}
                            </div>
                            {runnerAvailabilityBadge(runner.availabilityStatus)}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No Runner Profiles have been reported yet. Reconnect SPS Desktop to publish safe runtime metadata.</p>
                    )}
                  </div>

                  <div className="space-y-3 border-t border-border pt-5">
                    <div>
                      <h3 className="text-sm font-semibold">Agent execution access</h3>
                      <p className="text-sm text-muted-foreground">Only granted Agents can use this computer. The picker lists only Agents whose adapter has been discovered on this Node. A new Agent grant includes currently compatible Runner Profiles; later policy can narrow that access to a selected local profile. The first approved Node granted to an Agent becomes its primary execution Node. Later grants are available for reassignment and leave the current primary unchanged.</p>
                    </div>

                    {node.status === "active" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={selectedAgentId}
                          onValueChange={(value) => setAgentDrafts((current) => ({ ...current, [node.id]: value }))}
                        >
                          <SelectTrigger className="w-72 max-w-full"><SelectValue placeholder="Choose an Agent" /></SelectTrigger>
                          <SelectContent>
                            {availableAgents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentLabel(agent)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={!selectedAgentId || isMutating}
                          onClick={() => grantMutation.mutate({ nodeId: node.id, agentId: selectedAgentId })}
                        >Grant access</Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <CirclePause className="h-4 w-4" />
                        {node.keyVerifiedAt
                          ? "Approve this Node before granting Agent access."
                          : "SPS Desktop must complete a signed heartbeat before this Node can be approved."}
                      </div>
                    )}

                    {node.agentGrants.length > 0 ? (
                      <div className="divide-y divide-border rounded-md border border-border">
                        {node.agentGrants.map((grant) => {
                          const isPrimary = node.primaryAgentBindings.some((binding) => binding.agentId === grant.agentId);
                          return (
                            <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                  <span>{grant.agent?.title || grant.agent?.name || "Deleted Agent"}</span>
                                  {isPrimary ? <Badge className="bg-blue-600 text-white hover:bg-blue-600">Primary</Badge> : null}
                                </div>
                                {grant.agent?.title && grant.agent.name !== grant.agent.title ? <p className="text-xs text-muted-foreground">{grant.agent.name}</p> : null}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {isPrimary ? (
                                  <Button size="sm" variant="ghost" disabled={isMutating} onClick={() => clearBindingMutation.mutate(grant.agentId)}>
                                    <Unlink className="mr-1.5 h-4 w-4" />Clear primary
                                  </Button>
                                ) : (
                                  <Button size="sm" variant="outline" disabled={isMutating} onClick={() => bindMutation.mutate({ nodeId: node.id, agentId: grant.agentId })}>
                                    <Link2 className="mr-1.5 h-4 w-4" />Make primary
                                  </Button>
                                )}
                                <Button size="sm" variant="ghost" disabled={isMutating} onClick={() => revokeGrantMutation.mutate({ nodeId: node.id, agentId: grant.agentId })}>Remove</Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No Agent has execution access to this Node.</p>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Button variant="outline" size="sm" onClick={() => nodesQuery.refetch()} disabled={nodesQuery.isFetching}>
        <RefreshCw className="mr-1.5 h-4 w-4" />Refresh Nodes
      </Button>
    </div>
  );
}
