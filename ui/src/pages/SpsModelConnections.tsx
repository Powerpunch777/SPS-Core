import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Cpu, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { CompanySecret } from "@paperclipai/shared";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { ApiError } from "@/api/client";
import { pluginsApi, type CompanyPluginRecord } from "@/api/plugins";
import { secretsApi } from "@/api/secrets";
import {
  spsModelConnectionsApi,
  type SpsModelConnection,
  type SpsModelGrant,
} from "@/api/sps-model-connections";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";
import { Link } from "@/lib/router";

type LoadState = "checking" | "denied" | "error" | "loading" | "ready";
type Draft = { name: string; endpoint: string; model: string; secretId: string; allowLoopbackHttp: boolean; timeoutMs: number; maxOutputTokens: number };
type Confirmation = { title: string; description: string; actionLabel: string; action: () => Promise<void> };

const INITIAL_DRAFT: Draft = {
  name: "",
  endpoint: "",
  model: "",
  secretId: "",
  allowLoopbackHttp: false,
  timeoutMs: 30_000,
  maxOutputTokens: 1_024,
};

function canManageHostModels(access: CurrentBoardAccess | undefined) {
  if (!access) return false;
  if (isSpsCoreBaselineModeEnabled()) return access.isCoreHost === true || access.source === "local_implicit";
  return access.isInstanceAdmin === true || access.source === "local_implicit";
}

function selectableSecrets(secrets: readonly CompanySecret[]) {
  return secrets.filter(secret => secret.scope === "company" && secret.status === "active");
}

function usablePlugins(plugins: readonly CompanyPluginRecord[]) {
  return plugins.filter(plugin => plugin.status === "ready" && plugin.activation.enabled
    && plugin.capabilities?.includes("sps.models.submit"));
}

function pluginLabel(plugin: CompanyPluginRecord) {
  return plugin.displayName || plugin.pluginKey;
}

function transportEndpointIsAllowed(endpoint: string, allowLoopbackHttp: boolean) {
  try {
    if (endpoint !== endpoint.trim() || /[\u0000-\u0020\u007f\\]/.test(endpoint)) return false;
    const url = new URL(endpoint);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || url.search) return false;
    return url.protocol === "https:" || (allowLoopbackHttp && url.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

export function SpsModelConnections() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a Workspace to manage its model connections.</p>;
  return <WorkspaceModelConnections key={selectedCompanyId} companyId={selectedCompanyId} workspaceName={selectedCompany?.name ?? "Workspace"} />;
}

function WorkspaceModelConnections({ companyId, workspaceName }: { companyId: string; workspaceName: string }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [loadState, setLoadState] = useState<LoadState>("checking");
  const [connections, setConnections] = useState<SpsModelConnection[]>([]);
  const [secrets, setSecrets] = useState<CompanySecret[]>([]);
  const [plugins, setPlugins] = useState<CompanyPluginRecord[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [grants, setGrants] = useState<SpsModelGrant[] | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsError, setGrantsError] = useState(false);
  const [grantRefreshToken, setGrantRefreshToken] = useState(0);
  const [pluginId, setPluginId] = useState("");
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const alive = useRef(true);
  const mutationLock = useRef(false);
  const loadGeneration = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const grantGeneration = useRef(0);
  const grantController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      loadGeneration.current += 1;
      grantGeneration.current += 1;
      loadController.current?.abort();
      grantController.current?.abort();
      mutationController.current?.abort();
      mutationLock.current = false;
    };
  }, []);

  useEffect(() => {
    setBreadcrumbs([
      { label: workspaceName, href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Model connections" },
    ]);
  }, [setBreadcrumbs, workspaceName]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoadState("checking");
    setPageError(null);
    setConnections([]);
    setSecrets([]);
    setPlugins([]);
    setGrants(null);
    setSelectedConnectionId("");
    setFormError(null);
    setNotice(null);
    try {
      const access = await accessApi.getCurrentBoardAccess();
      if (!alive.current || generation !== loadGeneration.current) return;
      if (!canManageHostModels(access)) {
        setLoadState("denied");
        return;
      }
      setLoadState("loading");

      // This Host-only request must succeed before the page reads Secret or Plugin metadata.
      const rows = await spsModelConnectionsApi.list(companyId, { signal: controller.signal });
      if (!alive.current || generation !== loadGeneration.current) return;
      setConnections(rows);
      setSelectedConnectionId(current => rows.some(row => row.id === current) ? current : (rows[0]?.id ?? ""));

      const [secretRows, pluginResult] = await Promise.all([
        secretsApi.list(companyId),
        pluginsApi.listForCompany(companyId),
      ]);
      if (!alive.current || generation !== loadGeneration.current) return;
      setSecrets(secretRows);
      setPlugins(pluginResult.plugins);
      setLoadState("ready");
    } catch (error) {
      if (!alive.current || generation !== loadGeneration.current || controller.signal.aborted) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setLoadState("denied");
        return;
      }
      setLoadState("error");
      setPageError("Host model settings could not be loaded. Retry to check access and reload this Workspace.");
    }
  }, [companyId]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
      loadController.current?.abort();
    };
  }, [load, refreshToken]);

  const selectedConnection = connections.find(connection => connection.id === selectedConnectionId) ?? null;
  useEffect(() => setPluginId(""), [selectedConnectionId]);
  useEffect(() => {
    const generation = ++grantGeneration.current;
    grantController.current?.abort();
    setGrants(null);
    setGrantsError(false);
    if (loadState !== "ready" || !selectedConnection) {
      setGrantsLoading(false);
      return;
    }
    const controller = new AbortController();
    grantController.current = controller;
    setGrantsLoading(true);
    void spsModelConnectionsApi.listGrants(companyId, selectedConnection.id, { signal: controller.signal })
      .then(rows => {
        if (alive.current && generation === grantGeneration.current) setGrants(rows);
      })
      .catch(() => {
        if (alive.current && generation === grantGeneration.current && !controller.signal.aborted) setGrantsError(true);
      })
      .finally(() => {
        if (alive.current && generation === grantGeneration.current) setGrantsLoading(false);
      });
    return () => {
      grantGeneration.current += 1;
      controller.abort();
    };
  }, [companyId, loadState, selectedConnection?.id, grantRefreshToken]);

  const refreshConnections = async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    const generation = ++loadGeneration.current;
    loadController.current = controller;
    try {
      const rows = await spsModelConnectionsApi.list(companyId, { signal: controller.signal });
      if (!alive.current || generation !== loadGeneration.current) return;
      setConnections(rows);
      setSelectedConnectionId(current => rows.some(row => row.id === current) ? current : (rows[0]?.id ?? ""));
      setGrantRefreshToken(value => value + 1);
    } catch {
      if (alive.current && generation === loadGeneration.current && !controller.signal.aborted) {
        setConnections([]);
        setSecrets([]);
        setPlugins([]);
        setGrants(null);
        setLoadState("error");
        setPageError("The change was saved, but the latest connection list could not be loaded. Retry to refresh this Workspace.");
      }
    }
  };

  const runMutation = async (action: (signal: AbortSignal) => Promise<unknown>, success: string, reload: "connections" | "grants") => {
    if (busy || mutationLock.current || !alive.current) return false;
    mutationController.current?.abort();
    const controller = new AbortController();
    mutationController.current = controller;
    mutationLock.current = true;
    setBusy(true);
    setFormError(null);
    setPageError(null);
    setNotice(null);
    try {
      await action(controller.signal);
      if (!alive.current) return false;
      setNotice(success);
      if (reload === "connections") await refreshConnections();
      else setGrantRefreshToken(value => value + 1);
      return true;
    } catch (error) {
      if (alive.current && !controller.signal.aborted) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          setConnections([]);
          setSecrets([]);
          setPlugins([]);
          setGrants(null);
          setLoadState("denied");
        } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          setFormError("The change was not accepted. Check the connection settings and Plugin permissions.");
        } else {
          // A lost response does not prove that the server rolled back a write.
          // Reconcile with a fresh read before offering another mutation.
          setConnections([]);
          setSecrets([]);
          setPlugins([]);
          setGrants(null);
          setLoadState("error");
          setPageError("The result of this change could not be confirmed. Refresh settings before making another change.");
        }
      }
      return false;
    } finally {
      mutationLock.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const activeSecrets = selectableSecrets(secrets);
  const activePlugins = usablePlugins(plugins);
  const selectedSecret = activeSecrets.find(secret => secret.id === draft.secretId);
  const createConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || loadState !== "ready") return;
    setFormError(null);
    if (!selectedSecret) {
      setFormError("Choose an active Workspace credential before saving this connection.");
      return;
    }
    if (!transportEndpointIsAllowed(draft.endpoint, draft.allowLoopbackHttp)) {
      setFormError("Use an HTTPS endpoint. HTTP is allowed only for an explicitly approved loopback address.");
      return;
    }
    const saved = await runMutation(signal => spsModelConnectionsApi.create(companyId, {
      displayName: draft.name.trim(),
      secretId: selectedSecret.id,
      transport: {
        endpoint: draft.endpoint.trim(),
        model: draft.model.trim(),
        allowLoopbackHttp: draft.allowLoopbackHttp,
        timeoutMs: draft.timeoutMs,
        maxOutputTokens: draft.maxOutputTokens,
      },
    }, { signal }), "Model connection saved. The provider has not been contacted.", "connections");
    if (saved && alive.current) setDraft(INITIAL_DRAFT);
  };

  const changeStatus = async (connection: SpsModelConnection) => {
    if (connection.status === "active") {
      const activeGrantCount = selectedConnection?.id === connection.id
        ? (grants ?? []).filter(grant => grant.status === "active" && !grant.revokedAt).length
        : 0;
      const details = activeGrantCount > 0
        ? ` Disabling it will revoke ${activeGrantCount} Plugin grant${activeGrantCount === 1 ? "" : "s"}.`
        : " Disabling it revokes any Plugin grants.";
      setConfirmation({
        title: `Disable ${connection.displayName}?`,
        description: `This prevents new requests.${details} Re-enable and approve Plugins again to restore access.`,
        actionLabel: "Disable connection",
        action: async () => {
          await runMutation(
            signal => spsModelConnectionsApi.setStatus(companyId, connection.id, "disabled", { signal }),
            "Connection disabled and its grants revoked.",
            "connections",
          );
        },
      });
      return;
    }
    await runMutation(
      signal => spsModelConnectionsApi.setStatus(companyId, connection.id, "active", { signal }),
      "Connection enabled. Plugin grants require separate approval.",
      "connections",
    );
  };

  const grantPlugin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedConnection || !pluginId || busy) return;
    const saved = await runMutation(
      signal => spsModelConnectionsApi.grant(companyId, selectedConnection.id, pluginId, { signal }),
      "Plugin access approved for this model connection.",
      "grants",
    );
    if (saved && alive.current) setPluginId("");
  };

  const revokeGrant = async (grant: SpsModelGrant) => {
    setConfirmation({
      title: "Revoke Plugin access?",
      description: "The Plugin will no longer be able to use this model connection. You can approve it again later.",
      actionLabel: "Revoke access",
      action: async () => {
        await runMutation(
          signal => spsModelConnectionsApi.revoke(companyId, grant.id, { signal }),
          "Plugin access revoked.",
          "grants",
        );
      },
    });
  };

  if (loadState === "checking" || loadState === "loading") {
    return <p className="text-sm text-muted-foreground">{loadState === "checking" ? "Checking Host access…" : "Loading model connections…"}</p>;
  }

  if (loadState === "denied") {
    return <div className="max-w-3xl space-y-3"><p role="alert" className="text-sm text-muted-foreground">Only the local Host can manage model connections and Plugin grants for this Workspace.</p><p className="text-sm text-muted-foreground">This Workspace remains usable without an AI connection.</p><Button variant="outline" size="sm" onClick={() => setRefreshToken(value => value + 1)}><RefreshCw className="mr-1.5 h-4 w-4" />Retry access</Button></div>;
  }

  if (loadState === "error") {
    return <div className="max-w-3xl space-y-3"><p role="alert" className="text-sm text-destructive">{pageError}</p><Button variant="outline" size="sm" onClick={() => setRefreshToken(value => value + 1)}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh settings</Button></div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><Cpu className="h-5 w-5 text-muted-foreground" />Model connections</h1>
        <p className="text-sm text-muted-foreground">Set up a Host-managed Responses-compatible text endpoint, then approve each Plugin separately. AI is optional; this Workspace works without a connection.</p>
      </header>

      {pageError ? <p role="alert" className="text-sm text-destructive">{pageError}</p> : null}
      {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
      {notice ? <p role="status" className="text-sm text-foreground">{notice}</p> : null}

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="text-base">Saved connections</CardTitle>
          <CardDescription>Saved means configured. SPS has not checked provider availability or made a model request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {connections.length === 0 ? <p className="text-sm text-muted-foreground">No model connections are configured. The Workspace can still be used without AI.</p> : (
            <div className="divide-y rounded-md border">
              {connections.map(connection => (
                <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{connection.displayName}</span><span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">{connection.status === "active" ? "Enabled" : "Disabled"}</span></div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">{connection.model} · {connection.endpoint}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Responses-compatible text · Provider readiness unknown</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant={selectedConnectionId === connection.id ? "secondary" : "outline"} onClick={() => setSelectedConnectionId(connection.id)} aria-pressed={selectedConnectionId === connection.id}>Manage Plugin access</Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void changeStatus(connection)}>{connection.status === "active" ? "Disable" : "Enable"}</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setRefreshToken(value => value + 1)} disabled={busy}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="text-base">Add a model connection</CardTitle>
          <CardDescription>Credentials are stored as Workspace Secrets. Create or manage them on the <Link className="underline underline-offset-4" to="/company/settings/secrets">Manage credentials</Link> page.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={event => void createConnection(event)}>
            <label className="grid gap-1.5 text-sm">Connection name<Input required maxLength={160} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="Team model endpoint" disabled={busy} /></label>
            <label className="grid gap-1.5 text-sm">Workspace credential<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" required value={draft.secretId} onChange={event => setDraft(current => ({ ...current, secretId: event.target.value }))} disabled={busy || activeSecrets.length === 0}><option value="">Choose an active credential</option>{activeSecrets.map(secret => <option key={secret.id} value={secret.id}>{secret.name} · {secret.provider}</option>)}</select></label>
            {activeSecrets.length === 0 ? <p className="text-xs text-muted-foreground sm:col-span-2">Create an active Workspace credential before adding a connection.</p> : null}
            <label className="grid gap-1.5 text-sm sm:col-span-2">Responses endpoint URL<Input required type="url" value={draft.endpoint} onChange={event => setDraft(current => ({ ...current, endpoint: event.target.value }))} placeholder="https://api.example.com/v1/responses" disabled={busy} /></label>
            <label className="grid gap-1.5 text-sm">Model identifier<Input required maxLength={160} value={draft.model} onChange={event => setDraft(current => ({ ...current, model: event.target.value }))} placeholder="model-name" disabled={busy} /></label>
            <label className="grid gap-1.5 text-sm">Request timeout<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.timeoutMs} onChange={event => setDraft(current => ({ ...current, timeoutMs: Number(event.target.value) }))} disabled={busy}><option value={15_000}>15 seconds</option><option value={30_000}>30 seconds</option><option value={60_000}>60 seconds</option><option value={120_000}>120 seconds</option></select></label>
            <label className="grid gap-1.5 text-sm">Maximum output tokens<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={draft.maxOutputTokens} onChange={event => setDraft(current => ({ ...current, maxOutputTokens: Number(event.target.value) }))} disabled={busy}><option value={1_024}>1,024</option><option value={4_096}>4,096</option><option value={8_192}>8,192</option><option value={16_384}>16,384</option><option value={32_768}>32,768</option></select></label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2"><input className="mt-1" type="checkbox" checked={draft.allowLoopbackHttp} onChange={event => setDraft(current => ({ ...current, allowLoopbackHttp: event.target.checked }))} disabled={busy} /><span>Allow HTTP only for a loopback endpoint <span className="text-muted-foreground">(explicit opt-in for local providers)</span></span></label>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2"><Button type="submit" disabled={busy || activeSecrets.length === 0}>{busy ? "Saving…" : "Save connection"}</Button><span className="text-xs text-muted-foreground">Only HTTPS is accepted by default. Provider readiness remains unknown until a separate request is made.</span></div>
          </form>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Plugin access</CardTitle>
          <CardDescription>{selectedConnection ? `Choose which ready, enabled Plugins may use “${selectedConnection.displayName}”. Approval is explicit and can be revoked here.` : "Select a saved connection to review its Plugin grants."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!selectedConnection ? <p className="text-sm text-muted-foreground">Add a model connection before approving Plugin access.</p> : <>
            {grantsLoading ? <p className="text-sm text-muted-foreground">Loading Plugin grants…</p> : null}
            {grantsError ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">Plugin grants could not be loaded.</p><Button type="button" size="sm" variant="outline" onClick={() => setGrantRefreshToken(value => value + 1)} disabled={busy}>Retry</Button></div> : null}
            {grants && grants.length === 0 ? <p className="text-sm text-muted-foreground">No Plugin has access to this connection.</p> : null}
            {grants && grants.length > 0 ? <div className="divide-y rounded-md border">{grants.map(grant => {
              const plugin = plugins.find(item => item.id === grant.pluginId);
              const active = grant.status === "active" && !grant.revokedAt;
              return <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"><div className="min-w-0"><p className="text-sm font-medium">{plugin ? pluginLabel(plugin) : "Unavailable Plugin"}</p><p className="text-xs text-muted-foreground">{active ? "Access approved" : "Access revoked"}</p></div>{active ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revokeGrant(grant)}><X className="mr-1.5 h-3.5 w-3.5" />Revoke access</Button> : null}</div>;
            })}</div> : null}
            {selectedConnection.status === "active" ? <form className="flex flex-wrap items-end gap-2 border-t pt-4" onSubmit={event => void grantPlugin(event)}>
              <label className="grid min-w-60 flex-1 gap-1.5 text-sm">Ready Plugin<select className="h-9 rounded-md border border-input bg-background px-3 text-sm" required value={pluginId} onChange={event => setPluginId(event.target.value)} disabled={busy || activePlugins.length === 0}><option value="">Choose a ready Plugin</option>{activePlugins.map(plugin => <option key={plugin.id} value={plugin.id}>{pluginLabel(plugin)}</option>)}</select></label>
              <Button type="submit" disabled={busy || !pluginId || grantsLoading || grantsError}><Check className="mr-1.5 h-4 w-4" />Approve access</Button>
              {activePlugins.length === 0 ? <p className="basis-full text-xs text-muted-foreground">No ready, enabled Plugins are available in this Workspace.</p> : null}
            </form> : <p className="border-t pt-4 text-sm text-muted-foreground">Enable this connection before approving a Plugin.</p>}
          </>}
        </CardContent>
      </Card>
      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={event => {
              event.preventDefault();
              const pending = confirmation;
              setConfirmation(null);
              if (pending) void pending.action();
            }}>{busy ? "Saving…" : confirmation?.actionLabel}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
  }
