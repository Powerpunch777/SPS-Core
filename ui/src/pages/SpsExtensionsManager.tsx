import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "../compat/paperclip/shared";
import { CheckCircle2, ChevronDown, Power, Puzzle, Settings, ShieldCheck, Store, Trash } from "lucide-react";
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
  changing = false,
  uninstalling = false,
  onToggle,
  onUninstall,
}: {
  plugin: PluginRecord;
  activation: CompanyPluginActivation | null;
  changing?: boolean;
  uninstalling?: boolean;
  onToggle: () => void;
  onUninstall: () => void;
}) {
  const state = plugin.status === "ready" ? "Ready" : plugin.status.replaceAll("_", " ");
  const companyEnabled = activation?.enabled ?? false;
  const canChangeUse = plugin.status !== "upgrade_pending" && plugin.status !== "uninstalled";
  const useLabel = companyEnabled
    ? "Stop using"
    : plugin.status === "ready"
      ? "Use in this Workspace"
      : "Start and use";
  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="break-words">{extensionName(plugin)}</strong>
          <Badge variant="outline" className="font-normal">Host: {state}</Badge>
          <Badge variant="secondary" className="font-normal">
            Workspace: {companyEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {plugin.manifestJson.description || "No description provided."}
        </p>
        <p className="text-xs text-muted-foreground">v{plugin.manifestJson.version ?? plugin.version}</p>
        {plugin.status === "upgrade_pending" ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            This update is stopped for Host review. Open Settings to inspect and approve it.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
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
          size="icon"
          className="text-muted-foreground hover:text-destructive"
          disabled={!canChangeUse || uninstalling}
          onClick={onUninstall}
          aria-label={`Uninstall ${extensionName(plugin)}`}
          title="Uninstall"
        >
          <Trash className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Uninstall</span>
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

  const renderExtension = (plugin: PluginRecord) => {
    const activation = activationByPluginId.get(plugin.id) ?? null;
    return (
      <ExtensionRow
        key={plugin.id}
        plugin={plugin}
        activation={activation}
        changing={activationMutation.isPending && activationMutation.variables?.plugin.id === plugin.id}
        uninstalling={uninstallMutation.isPending && uninstallMutation.variables?.pluginId === plugin.id}
        onToggle={() => activationMutation.mutate({ plugin, enabled: !activation?.enabled })}
        onUninstall={() => setUninstallPlugin(plugin)}
      />
    );
  };

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
    <main data-sps-surface-owner="core" className="max-w-6xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Puzzle className="h-4 w-4" aria-hidden="true" />
            Core
          </div>
          <h1 className="text-xl font-semibold">Plugins</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {getDesktopPluginRegistryBridge() ? (
            <Button type="button" onClick={() => void openSecureInstallReview()} disabled={registryOpening}>
              {registryOpening ? "Opening review..." : "Open signed Registry review"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Host Desktop required to install signed Registry packages</span>
          )}
          {registryError ? <p role="alert" className="text-sm text-destructive">{registryError}</p> : null}
        </div>
      </header>
      <details className="group text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-muted-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Plugin lifecycle and installation
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="mt-2 space-y-1 pl-6 text-muted-foreground">
          <p>Installed plugins remain plugin-owned surfaces and appear only while they are active in this Workspace.</p>
          <p>Core controls package review and lifecycle. Each Workspace chooses which installed plugins contribute UI and behavior.</p>
          <p><strong className="font-medium text-foreground">Signed Registry only.</strong> Package lookup, signature review, staging, and explicit enablement happen in SPS Desktop. Direct npm installation is intentionally not available here.</p>
        </div>
      </details>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Built-in SPS components</h2>
        </div>
        {bundled.length ? (
          <Card className="py-0"><div className="divide-y">{bundled.map((plugin) => renderExtension(plugin))}</div></Card>
        ) : (
          <Card className="bg-muted/30"><CardContent className="py-5 text-sm text-muted-foreground">SPS is starting its built-in components. Refresh this page in a moment.</CardContent></Card>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Store className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Registry extensions</h2>
        </div>
        <Card className="py-0">
          {custom.length ? <div className="divide-y">{custom.map((plugin) => renderExtension(plugin))}</div> : (
            <CardContent className="py-5 text-sm text-muted-foreground">
              No Registry extensions are installed. Use <strong>Open signed Registry review</strong> to stage a release for Host review.
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
    </main>
  );
}
