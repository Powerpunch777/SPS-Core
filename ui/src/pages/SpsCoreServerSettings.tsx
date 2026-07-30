import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, HardDrive, Network, RefreshCw, ServerCog, ShieldCheck, UserRound, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";

type SpsServerSnapshot = {
  desktopAccount: { signedIn: boolean; name: string | null; email: string | null };
  ownerHost: { state: string; url: string | null; lastError: string | null };
  teamAccess: { enabled: boolean; url: string | null; companyId: string | null; configuredAt: string | null } | null;
  ownerHostCompanies: Array<{ id: string; name: string }>;
  agentRuntimePacks: Array<{ id: string; label: string; version: string; commands: string[]; complete: boolean }>;
};

type SpsMemberInvite = { id: string; state: string; createdAt: string | null; expiresAt: string | null };

type SpsServerBridge = {
  getServerSettings: () => Promise<SpsServerSnapshot>;
  enablePrivateTeamAccess: (input: { companyId: string }) => Promise<SpsServerSnapshot>;
  disablePrivateTeamAccess: () => Promise<SpsServerSnapshot>;
  installAgentRuntimePack: () => Promise<SpsServerSnapshot>;
  createMemberInvite: () => Promise<{ id: string; code: string; expiresAt: string | null }>;
  listMemberInvites: () => Promise<SpsMemberInvite[]>;
  revokeMemberInvite: (input: { inviteId: string }) => Promise<{ id: string; state: string }>;
  signOutDesktopAccount: () => Promise<unknown>;
};

function getSpsServerBridge(): SpsServerBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { spsDesktopWorkspace?: Partial<SpsServerBridge> }).spsDesktopWorkspace;
  if (!candidate
    || typeof candidate.getServerSettings !== "function"
    || typeof candidate.enablePrivateTeamAccess !== "function"
    || typeof candidate.disablePrivateTeamAccess !== "function"
    || typeof candidate.installAgentRuntimePack !== "function"
    || typeof candidate.createMemberInvite !== "function"
    || typeof candidate.listMemberInvites !== "function"
    || typeof candidate.revokeMemberInvite !== "function"
    || typeof candidate.signOutDesktopAccount !== "function") return null;
  return candidate as SpsServerBridge;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string | null) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function SpsCoreServerSettings() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const bridge = useMemo(() => getSpsServerBridge(), []);
  const [snapshot, setSnapshot] = useState<SpsServerSnapshot | null>(null);
  const [invites, setInvites] = useState<SpsMemberInvite[]>([]);
  const [latestInvite, setLatestInvite] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(bridge));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "SPS Server" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const reload = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const next = await bridge.getServerSettings();
      setSnapshot(next);
      setInvites(next.teamAccess?.enabled ? await bridge.listMemberInvites() : []);
    } catch (caught) {
      setError(errorMessage(caught, "SPS Server settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => { void reload(); }, [reload]);

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    if (!bridge || busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      await reload();
    } catch (caught) {
      setError(errorMessage(caught, "SPS Server could not complete that action."));
    } finally {
      setBusy(null);
    }
  };

  const copyInvite = async () => {
    if (!latestInvite) return;
    try {
      await navigator.clipboard.writeText(latestInvite);
      setNotice("The full SPS2 invitation was copied.");
    } catch {
      setNotice("Select and copy the full SPS2 invitation manually.");
    }
  };

  if (!bridge) {
    return (
      <div className="max-w-3xl space-y-6">
        <header className="flex items-center gap-2"><ServerCog className="h-5 w-5 text-muted-foreground" /><h1 className="text-lg font-semibold">SPS Server</h1></header>
        <Card className="py-0">
          <CardHeader><CardTitle className="text-base">Managed on the local Host</CardTitle><CardDescription>SPS Server controls are available only in the SPS Desktop app on the computer that hosts this Workspace.</CardDescription></CardHeader>
          <CardContent className="text-sm text-muted-foreground">This Member connection can use the Workspace, but it cannot change the Host server, Tailnet route, invitations, or installed runtime packs.</CardContent>
        </Card>
      </div>
    );
  }

  const teamAccess = snapshot?.teamAccess;
  const selectedCompanyId = selectedCompany?.id ?? "";
  const selectedCompanyExists = snapshot?.ownerHostCompanies.some((company) => company.id === selectedCompanyId) ?? false;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 py-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2"><ServerCog className="h-5 w-5 text-muted-foreground" /><h1 className="text-xl font-semibold">SPS Server</h1></div>
          <p className="max-w-2xl text-sm text-muted-foreground">Host-only server, private team route, and optional runtime pack controls for this computer.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()} disabled={loading || busy !== null}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button>
      </header>

      {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading local SPS Server...</p> : null}

      {snapshot ? <>
        <Card className="py-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Local Host</CardTitle>
            <CardDescription>This computer owns the local SPS data and serves the selected Workspace.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <p><span className="text-muted-foreground">Status: </span>{snapshot.ownerHost.state}</p>
            <p className="break-all"><span className="text-muted-foreground">Local address: </span>{snapshot.ownerHost.url ?? "Starting"}</p>
            <p><span className="text-muted-foreground">Account: </span>{snapshot.desktopAccount.email ?? snapshot.desktopAccount.name ?? "Not signed in"}</p>
            {snapshot.ownerHost.lastError ? <p className="text-destructive sm:col-span-2">{snapshot.ownerHost.lastError}</p> : null}
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Network className="h-4 w-4" />Private team access</CardTitle>
            <CardDescription>Tailscale keeps SPS available only to approved computers in your Tailnet. New teammates receive a routed SPS2 invitation.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {teamAccess?.enabled ? <>
              <div className="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"><span className="font-medium">Active</span><span className="text-muted-foreground"> - {teamAccess.url ?? "Private Tailnet route"}</span></div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => void run("invite", async () => { const invite = await bridge.createMemberInvite(); setLatestInvite(invite.code); }, "A full SPS2 invitation is ready to share.")} disabled={busy !== null}><UserRound className="mr-1.5 h-4 w-4" />Create teammate invitation</Button>
                <Button type="button" variant="outline" onClick={() => {
                  if (!window.confirm("Disable private team access? Existing member records remain, but the Tailnet route will stop.")) return;
                  void run("disable-team", async () => { await bridge.disablePrivateTeamAccess(); setLatestInvite(null); }, "Private team access was disabled.");
                }} disabled={busy !== null}>Disable private access</Button>
              </div>
              {latestInvite ? <div className="flex flex-wrap gap-2"><Input aria-label="Full SPS2 invitation" readOnly value={latestInvite} className="min-w-[16rem] flex-1 font-mono text-xs" /><Button type="button" variant="outline" onClick={() => void copyInvite()}><Copy className="mr-1.5 h-4 w-4" />Copy</Button></div> : null}
              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">Active invitations</h3>
                {invites.length === 0 ? <p className="text-sm text-muted-foreground">No active private-team invitations.</p> : invites.map((invite) => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"><span>Expires {formatDate(invite.expiresAt)}</span><Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run(`revoke-${invite.id}`, async () => { await bridge.revokeMemberInvite({ inviteId: invite.id }); }, "Invitation revoked.")}><XCircle className="mr-1.5 h-3.5 w-3.5" />Revoke</Button></div>)}
              </div>
            </> : <>
              <p className="text-sm text-muted-foreground">Enable the selected Workspace for private Tailnet access. SPS will verify the local Tailscale configuration before changing the route.</p>
              <Button type="button" onClick={() => void run("enable-team", async () => { await bridge.enablePrivateTeamAccess({ companyId: selectedCompanyId }); }, "Private team access is active. You can now create full SPS2 invitations.")} disabled={!selectedCompanyId || !selectedCompanyExists || busy !== null}><ShieldCheck className="mr-1.5 h-4 w-4" />Enable private access for {selectedCompany?.name ?? "this Workspace"}</Button>
              {!selectedCompanyExists ? <p className="text-xs text-muted-foreground">Select a Workspace owned by this local Host before enabling private team access.</p> : null}
            </>}
          </CardContent>
        </Card>

        <Card className="py-0">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><HardDrive className="h-4 w-4" />Agent runtime packs</CardTitle><CardDescription>Optional packaged provider runtimes. Existing CLIs on this Host remain available without a pack.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {snapshot.agentRuntimePacks.length ? <div className="space-y-2">{snapshot.agentRuntimePacks.map((pack) => <div key={pack.id} className="rounded-md border px-3 py-2 text-sm"><strong>{pack.label} {pack.version}</strong><span className="ml-2 text-muted-foreground">{pack.complete ? pack.commands.join(", ") : "Incomplete"}</span></div>)}</div> : <p className="text-sm text-muted-foreground">No optional runtime packs installed.</p>}
            <Button type="button" variant="outline" onClick={() => void run("runtime-pack", async () => { await bridge.installAgentRuntimePack(); }, "Runtime pack installation finished. Restart the Host before using a newly installed runtime.")} disabled={busy !== null}>Install extracted runtime pack</Button>
          </CardContent>
        </Card>
      </> : null}
    </div>
  );
}
