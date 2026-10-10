import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "../compat/paperclip/shared";
import { CheckCircle2, Power, Puzzle, Settings, ShieldCheck, Store, Trash } from "lucide-react";
import { pluginsApi, type CompanyPluginActivation } from "@/api/plugins";
import { PluginUninstallDialog, type PluginUninstallOptions } from "@/components/PluginUninstallDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useToastActions } from "@/context/ToastContext";
import { SpsMarketplacePanel } from "@/components/SpsMarketplacePanel";

type DesktopPluginRegistryBridge = {
  openPluginRegistries: () => Promise<{ opened?: boolean }>;
};

function getDesktopPluginRegistryBridge(): DesktopPluginRegistryBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { spsDesktopWorkspace?: Partial<DesktopPluginRegistryBridge> })
    .spsDesktopWorkspace;
  return candidate && typeof candidate.openPluginRegistries === "function"
    ? candidate as DesktopPluginRegistryBridge
    : null;
}

const SPS_BUNDLED_EXTENSION_IDS = new Set([
  "sps.default-memory",
  "sps.plugin-discovery",
  "local.room-chat",
]);

function extensionId(plugin: PluginRecord): string {
  return plugin.manifestJson.id ?? plugin.packageName;
}

function extensionName(plugin: PluginRecord): string {
  return plugin.manifestJson.displayName ?? plugin.packageName;
}

function isSpsBundledExtension(plugin: PluginRecord): boolean {
  return SPS_BUNDLED_EXTENSION_IDS.has(extensionId(plugin));
}

function isLegacyPaperclipExtension(plugin: PluginRecord): boolean {
  return plugin.packageName.startsWith("@paperclipai/");
}

function ExtensionRow({
  plugin,
  activation,
  builtIn = false,
  changing = false,
  uninstalling = false,
  onToggle,
  onUninstall,
}: {
  plugin: PluginRecord;
  activation: CompanyPluginActivation | null;
  builtIn?: boolean;
  changing?: boolean;
  uninstalling?: boolean;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const state = plugin.status === "ready" ? "Ready" : plugin.status;
  const companyEnabled = activation?.enabled ?? false;
  const canChangeUse = plugin.status !== "upgrade_pending" && plugin.status !== "uninstalled";
  const useLabel = companyEnabled
    ? "Stop using"
    : plugin.status === "ready"
      ? "Use in this Workspace"
      : "Start and use";
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="truncate">{extensionName(plugin)}</strong>
          <Badge variant="outline">{builtIn ? "SPS built-in" : "Custom"}</Badge>
          <Badge className={plugin.status === "ready" ? "bg-emerald-600 hover:bg-emerald-700" : undefined} variant={plugin.status === "ready" ? "default" : "secondary"}>
            {state}
          </Badge>
          <Badge variant={companyEnabled ? "default" : "secondary"} className={companyEnabled ? "bg-blue-600 hover:bg-blue-700" : undefined}>
            {companyEnabled ? "Enabled in this Workspace" : "Disabled in this Workspace"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {plugin.manifestJson.description || "No description provided."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">v{plugin.manifestJson.version ?? plugin.version}</p>
        {plugin.status === "upgrade_pending" ? (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            This update is stopped for Host review. Open Settings to inspect and approve it.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant={companyEnabled ? "outline" : "default"}
          size="sm"
          disabled={!canChangeUse || changing}
          onClick={onToggle}
        >
          <Power className="h-4 w-4" />
          {useLabel}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
            <Settings className="h-4 w-4" />
            {plugin.status === "upgrade_pending" ? "Review update" : "Settings"}
          </Link>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={!canChangeUse || uninstalling}
          onClick={onUninstall}
        >
          <Trash className="h-4 w-4" />
          Uninstall
        </Button>
      </div>
    </div>
  );
}

export function SpsExtensionsManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [activeSection, setActiveSection] = useState<"installed" | "marketplace">("installed");
  const [registryOpening, setRegistryOpening] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [uninstallPlugin, setUninstallPlugin] = useState<PluginRecord | null>(null);
  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const companyPluginsQuery = useQuery({
    queryKey: queryKeys.plugins.companyActivation(selectedCompany?.id ?? "none"),
    queryFn: () => pluginsApi.listForCompany(selectedCompany!.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const activationMutation = useMutation({
    mutationFn: async ({ plugin, enabled }: { plugin: PluginRecord; enabled: boolean }) => {
      // A Host installs a package once, while each Workspace chooses whether to
      // use it. Keep that implementation detail behind one deliberate action:
      // starting a paused package and enabling it for this Workspace happen as
      // one operation. Stopping use only changes this Workspace; it never
      // interrupts another Workspace that may rely on the same package.
      if (enabled && plugin.status !== "ready") {
        await pluginsApi.enable(plugin.id);
      }
      return await pluginsApi.setCompanyActivation(plugin.id, selectedCompany!.id, enabled);
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.companyActivation(selectedCompany!.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributionsPrefix }),
      ]);
      pushToast({
        title: variables.enabled ? "Extension ready in this Workspace" : "Extension stopped for this Workspace",
        body: variables.enabled
          ? "Its navigation and pages are now available without changing other Workspaces."
          : "The package stays available on this Host for other Workspaces.",
        tone: variables.enabled ? "success" : "info",
      });
    },
    onError: (error: Error) => {
      pushToast({ title: "Could not change Workspace extension", body: error.message, tone: "error" });
    },
  });
  const uninstallMutation = useMutation({
    mutationFn: ({ pluginId, options }: { pluginId: string; options: PluginUninstallOptions }) =>
      pluginsApi.uninstall(pluginId, options),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributionsPrefix }),
      ]);
      pushToast({ title: "Extension uninstalled", tone: "success" });
    },
    onError: (error: Error) => {
      pushToast({ title: "Could not uninstall extension", body: error.message, tone: "error" });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "SPS" , href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Plugins" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const installed = plugins ?? [];
  const bundled = useMemo(() => installed.filter(isSpsBundledExtension), [installed]);
  const custom = useMemo(
    () => installed.filter((plugin) => !isSpsBundledExtension(plugin) && !isLegacyPaperclipExtension(plugin)),
    [installed],
  );
  const activationByPluginId = useMemo(
    () => new Map(companyPluginsQuery.data?.plugins.map((plugin) => [plugin.id, plugin.activation]) ?? []),
    [companyPluginsQuery.data],
  );

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading SPS extensions...</div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load SPS extensions.</div>;
  if (!selectedCompany) return <div className="p-4 text-sm text-muted-foreground">Select a Workspace to manage its extensions.</div>;
  if (companyPluginsQuery.isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading Workspace extensions...</div>;
  if (companyPluginsQuery.error) return <div className="p-4 text-sm text-destructive">Failed to load Workspace extension settings.</div>;

  const renderExtension = (plugin: PluginRecord, builtIn: boolean) => {
    const activation = activationByPluginId.get(plugin.id) ?? null;
    return (
      <ExtensionRow
        key={plugin.id}
        plugin={plugin}
        activation={activation}
        builtIn={builtIn}
        changing={activationMutation.isPending && activationMutation.variables?.plugin.id === plugin.id}
        uninstalling={uninstallMutation.isPending && uninstallMutation.variables?.pluginId === plugin.id}
        onToggle={() => activationMutation.mutate({ plugin, enabled: !activation?.enabled })}
        onUninstall={() => setUninstallPlugin(plugin)}
      />
    );
  };

  const sectionTabs = (
    <div className="flex w-fit gap-1 rounded-md border bg-muted/40 p-1" role="tablist" aria-label="Plugin sections">
      <Button type="button" size="sm" variant={activeSection === "installed" ? "secondary" : "ghost"} role="tab" aria-selected={activeSection === "installed"} onClick={() => setActiveSection("installed")}>Installed</Button>
      <Button type="button" size="sm" variant={activeSection === "marketplace" ? "secondary" : "ghost"} role="tab" aria-selected={activeSection === "marketplace"} onClick={() => setActiveSection("marketplace")}>Marketplace</Button>
    </div>
  );

  async function openSecureInstallReview() {
    const bridge = getDesktopPluginRegistryBridge();
    if (!bridge) return;
    setRegistryError(null);
    setRegistryOpening(true);
    try {
      const result = await bridge.openPluginRegistries();
      if (result?.opened !== true) throw new Error("SPS Desktop did not open the plugin review window.");
    } catch (error) {
      setRegistryError(error instanceof Error ? error.message : "Could not open the plugin review window.");
    } finally {
      setRegistryOpening(false);
    }
  }

  return (
    <main data-sps-surface-owner="core" className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="max-w-3xl space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Puzzle className="h-4 w-4" aria-hidden="true" />
            Core Platform
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Core controls package review and lifecycle. Each Workspace chooses which installed plugins contribute UI and behavior.
            </p>
          </div>
        </div>
        {sectionTabs}
      </header>

      <section className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
        <Badge variant="secondary">Core surface</Badge>
        <p className="text-muted-foreground">
          Installed plugins remain plugin-owned surfaces and appear only while they are active in this Workspace.
        </p>
      </section>

      {activeSection === "marketplace" ? (
        <>
          <Card className="border-blue-500/20 bg-blue-500/[0.035]">
            <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="flex min-w-0 gap-3">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700 dark:text-blue-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Host-controlled installation</p>
                  <p className="text-muted-foreground">
                    Marketplace search and Assistant recommendations never install code. The Host must stage, review, and apply an exact signed version.
                  </p>
                  {registryError ? <p role="alert" className="text-destructive">{registryError}</p> : null}
                </div>
              </div>
              {getDesktopPluginRegistryBridge() ? (
                <Button type="button" onClick={() => void openSecureInstallReview()} disabled={registryOpening}>
                  {registryOpening ? "Opening review..." : "Open secure install review"}
                </Button>
              ) : (
                <Badge variant="secondary">Host Desktop required to install</Badge>
              )}
            </CardContent>
          </Card>
          <SpsMarketplacePanel companyId={selectedCompany.id} />
        </>
      ) : (
        <>
      <Card className="border-blue-500/20 bg-blue-500/[0.035]">
        <CardContent className="flex gap-3 py-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700 dark:text-blue-300" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Signed Registry only</p>
            <p className="text-muted-foreground">
              Package discovery, signature review, staging, and explicit enablement happen in SPS Desktop. Direct npm installation is intentionally not available here.
            </p>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Built-in SPS components</h2>
        </div>
        {bundled.length ? (
          <Card className="py-0"><div className="divide-y">{bundled.map((plugin) => renderExtension(plugin, true))}</div></Card>
        ) : (
          <Card className="bg-muted/30"><CardContent className="py-5 text-sm text-muted-foreground">SPS is starting its built-in components. Refresh this page in a moment.</CardContent></Card>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Registry extensions</h2>
        </div>
        <Card className="py-0">
          {custom.length ? <div className="divide-y">{custom.map((plugin) => renderExtension(plugin, false))}</div> : (
            <CardContent className="py-5 text-sm text-muted-foreground">
              No Registry extensions are installed. Open Marketplace, then use <strong>Open secure install review</strong> to stage a trusted release.
            </CardContent>
          )}
        </Card>
      </section>

      <PluginUninstallDialog
        open={uninstallPlugin !== null}
        pluginName={uninstallPlugin ? extensionName(uninstallPlugin) : ""}
        pending={uninstallMutation.isPending}
        onOpenChange={(open) => { if (!open) setUninstallPlugin(null); }}
        onConfirm={(options) => {
          if (!uninstallPlugin) return;
          uninstallMutation.mutate({ pluginId: uninstallPlugin.id, options }, {
            onSettled: () => setUninstallPlugin(null),
          });
        }}
      />
        </>
      )}
    </main>
  );
}
