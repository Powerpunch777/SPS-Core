import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, MailPlus, ShieldCheck, UserRoundMinus, XCircle } from "lucide-react";
import { accessApi } from "@/api/access";
import { spsNodesApi } from "@/api/spsNodes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { buildSpsDesktopJoinUri, inviteTokenToSpsCode } from "@/lib/sps-invite-code";

type InviteExpiryMinutes = 60 | 1440 | 10080;

type LatestInvite = {
  token: string;
  inviteUrl: string;
  expiresAt: string;
};

const expiryOptions: ReadonlyArray<{ value: InviteExpiryMinutes; label: string }> = [
  { value: 60, label: "1 hour" },
  { value: 1440, label: "24 hours" },
  { value: 10080, label: "7 days" },
];

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Baseline Core access is deliberately technical: it grants a person entry to
 * the Workspace, while any workflow role is interpreted by an enabled plugin.
 * The legacy server still needs an internal membership value for compatibility.
 */
export function SpsCoreTeamAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  // Shareable links and pending mutation state belong to one Workspace lifetime.
  return <WorkspaceTeamAccess key={selectedCompanyId ?? "none"} companyId={selectedCompanyId} companyName={selectedCompany?.name ?? "Workspace"} />;
}

function WorkspaceTeamAccess({ companyId: selectedCompanyId, companyName }: { companyId: string | null; companyName: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const desktopInviteInputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(true);
  const [expiresInMinutes, setExpiresInMinutes] = useState<InviteExpiryMinutes>(60);
  const [latestInvite, setLatestInvite] = useState<LatestInvite | null>(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    setBreadcrumbs([
      { label: companyName, href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Team access" },
    ]);
  }, [companyName, setBreadcrumbs]);

  const invitesQuery = useQuery({
    queryKey: ["sps-core", "team-invites", selectedCompanyId],
    queryFn: () => accessApi.listInvites(selectedCompanyId!, { limit: 12, offset: 0 }),
    enabled: Boolean(selectedCompanyId),
  });

  const membersQuery = useQuery({
    queryKey: ["sps-core", "technical-members", selectedCompanyId],
    queryFn: () => spsNodesApi.listTechnicalMembers(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createInviteMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("Choose a Workspace before creating an invitation.");
      return accessApi.createCompanyInvite(selectedCompanyId, {
        allowedJoinTypes: "human",
        // Compatibility-only membership level. Plugins own visible workflow roles.
        humanRole: "operator",
        agentMessage: null,
        expiresInMinutes,
      });
    },
    onSuccess: async (invite) => {
      if (activeRef.current) {
        setLatestInvite({ token: invite.token, inviteUrl: invite.inviteUrl, expiresAt: invite.expiresAt });
        setCopied(false);
      }
      await queryClient.invalidateQueries({ queryKey: ["sps-core", "team-invites", selectedCompanyId] });
      if (!activeRef.current) return;
      pushToast({ title: "Member invitation created", body: "Share the full SPS Desktop invitation below.", tone: "success" });
    },
    onError: (error) => {
      if (!activeRef.current) return;
      pushToast({ title: "Could not create member invitation", body: errorMessage(error, "Unknown error"), tone: "error" });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sps-core", "team-invites", selectedCompanyId] });
      if (!activeRef.current) return;
      pushToast({ title: "Invitation revoked", tone: "success" });
    },
    onError: (error) => {
      if (!activeRef.current) return;
      pushToast({ title: "Could not revoke invitation", body: errorMessage(error, "Unknown error"), tone: "error" });
    },
  });

  const revokeMemberMutation = useMutation({
    mutationFn: (memberId: string) => {
      if (!selectedCompanyId) throw new Error("Choose a Workspace before removing a member.");
      return spsNodesApi.revokeTechnicalMember(selectedCompanyId, memberId);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["sps-core", "technical-members", selectedCompanyId] });
      await queryClient.invalidateQueries({ queryKey: ["sps-nodes", selectedCompanyId] });
      if (!activeRef.current) return;
      pushToast({
        title: "Member access removed",
        body: result.revokedNodeCount > 0
          ? `${result.revokedNodeCount} connected Node${result.revokedNodeCount === 1 ? "" : "s"} was revoked.`
          : "No connected Nodes needed revocation.",
        tone: "success",
      });
    },
    onError: (error) => {
      if (!activeRef.current) return;
      pushToast({ title: "Could not remove member access", body: errorMessage(error, "Unknown error"), tone: "error" });
    },
  });

  const desktopInvite = useMemo(
    () => latestInvite ? buildSpsDesktopJoinUri(latestInvite.inviteUrl, latestInvite.token) : null,
    [latestInvite],
  );
  const shortCode = latestInvite ? inviteTokenToSpsCode(latestInvite.token) : null;
  const inviteHistory = invitesQuery.data?.invites ?? [];
  const technicalMembers = membersQuery.data?.members ?? [];

  async function copyDesktopInvite() {
    if (!desktopInvite) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(desktopInvite);
      if (!activeRef.current) return;
      setCopied(true);
      window.setTimeout(() => { if (activeRef.current) setCopied(false); }, 1600);
      pushToast({ title: "Desktop invitation copied", tone: "success" });
    } catch {
      if (!activeRef.current) return;
      desktopInviteInputRef.current?.focus();
      desktopInviteInputRef.current?.select();
      pushToast({ title: "Copy the selected invitation manually", tone: "warn" });
    }
  }

  function removeMember(memberId: string, accountId: string) {
    if (!window.confirm(`Remove SPS access for ${accountId}? Their connected Nodes and technical access grants will be revoked. Workflow records remain available to enabled plugins.`)) return;
    revokeMemberMutation.mutate(memberId);
  }

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Choose a Workspace to manage team access.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 py-2">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Team access</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Invite a person to sign in and connect SPS Desktop to this Workspace. This is technical access only; enabled plugins define workflow roles and permissions.
        </p>
      </header>

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="text-base">Create member invitation</CardTitle>
          <CardDescription>The receiving computer needs SPS Desktop. A Host approves its Node separately after it connects.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 pb-5">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Expires
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              value={expiresInMinutes}
              onChange={(event) => setExpiresInMinutes(Number(event.target.value) as InviteExpiryMinutes)}
              disabled={createInviteMutation.isPending}
            >
              {expiryOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button type="button" onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            <MailPlus className="h-4 w-4" />
            {createInviteMutation.isPending ? "Creating..." : "Create invitation"}
          </Button>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><UserRoundMinus className="h-4 w-4" />Connected members</CardTitle>
          <CardDescription>These are technical SPS connections. Removing a person archives their connection record and revokes their Nodes; workflow roles and records stay under plugin control.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 pb-5">
          {membersQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading connected members...</p> : null}
          {membersQuery.isError ? <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>Connected members could not be loaded.</p>
            <Button type="button" size="sm" variant="outline" disabled={membersQuery.isFetching} onClick={() => void membersQuery.refetch()}>Retry members</Button>
          </div> : null}
          {!membersQuery.isLoading && !membersQuery.isError && technicalMembers.length === 0 ? <p className="text-sm text-muted-foreground">No one has connected to this Workspace yet.</p> : null}
          {technicalMembers.map((member) => (
            <div key={member.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <p className="break-all font-medium">{member.accountId.startsWith("sps_identity_")
                  ? member.isHost ? "SPS Host" : `Member · ${member.accountId.slice(-6)}`
                  : `${member.accountId}${member.isHost ? " (SPS Host)" : ""}`}</p>
                {member.accountId.startsWith("sps_identity_") ? <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Account ID</summary><p className="break-all font-mono">{member.accountId}</p>
                </details> : null}
                <p className="text-xs text-muted-foreground">
                  {member.status === "active"
                    ? `${member.activeNodeCount} active of ${member.nodeCount} connected Node${member.nodeCount === 1 ? "" : "s"}`
                    : `Removed ${member.archivedAt ? formatDate(member.archivedAt) : ""}`}
                </p>
              </div>
              {member.status === "active" && !member.isHost ? (
                <Button type="button" size="sm" variant="outline" onClick={() => removeMember(member.id, member.accountId)} disabled={revokeMemberMutation.isPending}>
                  <UserRoundMinus className="h-3.5 w-3.5" />Remove access
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {latestInvite ? (
        <Card className="border-blue-500/30 bg-blue-500/5 py-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4" />Desktop invitation ready</CardTitle>
            <CardDescription>Share this full link. It carries both the one-time invitation and the team address, so a new SPS Desktop installation does not need a separately configured server.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pb-5">
            {desktopInvite ? (
              <div className="flex flex-wrap gap-2">
                <Input ref={desktopInviteInputRef} aria-label="Full SPS Desktop invitation" readOnly value={desktopInvite} className="min-w-64 flex-1 font-mono text-xs" />
                <Button type="button" variant="outline" onClick={() => void copyDesktopInvite()}><Copy className="h-4 w-4" />{copied ? "Copied" : "Copy full invitation"}</Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span>Expires {formatDate(latestInvite.expiresAt)}</span>
              {shortCode ? <span>Short code: {shortCode} (only for a computer that already knows the team address)</span> : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Recent invitations</CardTitle>
          <CardDescription>Revoking an unused invitation prevents it from joining this Workspace. It never deletes a connected person's local files.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 pb-5">
          {invitesQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading invitations...</p> : null}
          {invitesQuery.isError ? <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>Invitations could not be loaded.</p>
            <Button type="button" size="sm" variant="outline" disabled={invitesQuery.isFetching} onClick={() => void invitesQuery.refetch()}>Retry invitations</Button>
          </div> : null}
          {!invitesQuery.isLoading && !invitesQuery.isError && inviteHistory.length === 0 ? <p className="text-sm text-muted-foreground">No invitations have been created for this Workspace.</p> : null}
          {inviteHistory.map((invite) => (
            <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{formatInviteState(invite.state)}</p>
                <p className="text-xs text-muted-foreground">Created {formatDate(invite.createdAt)} · Expires {formatDate(invite.expiresAt)}</p>
              </div>
              {invite.state === "active" ? (
                <Button type="button" size="sm" variant="outline" onClick={() => revokeInviteMutation.mutate(invite.id)} disabled={revokeInviteMutation.isPending}>
                  <XCircle className="h-3.5 w-3.5" />Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
