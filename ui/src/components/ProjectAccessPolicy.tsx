import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, ProjectAccessGrant, ProjectAccessMode, ProjectAccessRole } from "@paperclipai/shared";
import { ShieldCheck, UsersRound } from "lucide-react";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";

type DraftGrant = Pick<ProjectAccessGrant, "principalType" | "principalId" | "accessRole">;

function grantKey(grant: DraftGrant) {
  return `${grant.principalType}:${grant.principalId}`;
}

function principalLabel(grant: DraftGrant, grants: ProjectAccessGrant[]) {
  const resolved = grants.find((candidate) => grantKey(candidate) === grantKey(grant));
  return resolved?.principal?.name ?? resolved?.principal?.email ?? grant.principalId;
}

export function ProjectAccessPolicy({ project, companyId }: { project: Project; companyId: string }) {
  const queryClient = useQueryClient();
  const [accessMode, setAccessMode] = useState<ProjectAccessMode>(project.accessMode ?? "company");
  const [grants, setGrants] = useState<DraftGrant[]>([]);
  const [candidate, setCandidate] = useState("");

  const policyQuery = useQuery({
    queryKey: ["project-access-policy", project.id, companyId],
    queryFn: () => projectsApi.getAccessPolicy(project.id, companyId),
    enabled: Boolean(project.id && companyId),
    retry: false,
  });
  const membersQuery = useQuery({
    queryKey: ["project-access-members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
    enabled: policyQuery.isSuccess,
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: ["project-access-agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: policyQuery.isSuccess,
    retry: false,
  });

  useEffect(() => {
    if (!policyQuery.data) return;
    setAccessMode(policyQuery.data.accessMode);
    setGrants(policyQuery.data.grants.map((grant) => ({
      principalType: grant.principalType,
      principalId: grant.principalId,
      accessRole: grant.accessRole,
    })));
  }, [policyQuery.data]);

  const existingGrants = policyQuery.data?.grants ?? [];
  const candidates = useMemo(() => {
    const used = new Set(grants.map(grantKey));
    const people = (membersQuery.data?.members ?? [])
      .filter((member) => member.status === "active" && member.principalType === "user")
      .map((member) => ({
        value: `user:${member.principalId}`,
        label: member.user?.name ?? member.user?.email ?? member.principalId,
      }));
    const agents = (agentsQuery.data ?? [])
      .filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval")
      .map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (Agent)` }));
    return [...people, ...agents].filter((entry) => !used.has(entry.value));
  }, [agentsQuery.data, grants, membersQuery.data?.members]);

  const savePolicy = useMutation({
    mutationFn: () => projectsApi.updateAccessPolicy(project.id, { accessMode, grants }, companyId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-access-policy", project.id, companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) }),
      ]);
    },
  });

  if (policyQuery.isLoading) return <div className="text-sm text-muted-foreground">Loading Project access...</div>;
  // The API deliberately returns 403 for non-admin collaborators. Their task
  // view stays uncluttered while the Project owner can configure the boundary.
  if (policyQuery.isError) return null;

  return (
    <section className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Project access</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Company keeps the current team-wide behavior. Restricted lets only listed people and Agents open this Project; Company Owners and Admins retain recovery access.
          </p>
        </div>
      </div>

      <label className="grid gap-1 text-xs text-muted-foreground">
        Access scope
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
          value={accessMode}
          onChange={(event) => setAccessMode(event.target.value as ProjectAccessMode)}
          disabled={savePolicy.isPending}
        >
          <option value="company">Company - all active Company members</option>
          <option value="restricted">Restricted - only explicit grants</option>
        </select>
      </label>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <UsersRound className="h-3.5 w-3.5" />
          Explicit grants
          <Badge variant="outline" className="text-(length:--text-micro)">{grants.length}</Badge>
        </div>
        {grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">No explicit grants. In Restricted mode, only Company Owners and Admins can recover this Project until grants are added.</p>
        ) : (
          <div className="space-y-2">
            {grants.map((grant) => (
              <div key={grantKey(grant)} className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{principalLabel(grant, existingGrants)}</span>
                <select
                  className="h-8 rounded border border-input bg-background px-2 text-xs"
                  value={grant.accessRole}
                  onChange={(event) => setGrants((current) => current.map((entry) =>
                    grantKey(entry) === grantKey(grant)
                      ? { ...entry, accessRole: event.target.value as ProjectAccessRole }
                      : entry,
                  ))}
                  disabled={savePolicy.isPending}
                >
                  <option value="viewer">Viewer</option>
                  <option value="collaborator">Collaborator</option>
                  <option value="manager">Manager</option>
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setGrants((current) => current.filter((entry) => grantKey(entry) !== grantKey(grant)))}
                  disabled={savePolicy.isPending}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <select
            className="h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm"
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
            disabled={savePolicy.isPending || candidates.length === 0}
          >
            <option value="">Add a person or Agent...</option>
            {candidates.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!candidate || savePolicy.isPending}
            onClick={() => {
              const [principalType, principalId] = candidate.split(":", 2) as ["user" | "agent", string];
              if (!principalType || !principalId) return;
              setGrants((current) => [...current, { principalType, principalId, accessRole: "collaborator" }]);
              setCandidate("");
            }}
          >
            Add
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Assigned Workers retain Task-scoped collaboration access. A Lead needs Manager access to create new Tasks.</p>
        <Button type="button" size="sm" onClick={() => savePolicy.mutate()} disabled={savePolicy.isPending}>
          {savePolicy.isPending ? "Saving..." : "Save access"}
        </Button>
      </div>
      {savePolicy.isError ? <p className="text-xs text-destructive">{savePolicy.error instanceof Error ? savePolicy.error.message : "Failed to save Project access."}</p> : null}
    </section>
  );
}
