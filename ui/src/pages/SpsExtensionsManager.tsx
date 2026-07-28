import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@paperclipai/shared";
import { CheckCircle2, Power, Puzzle, Settings, ShieldCheck, Store } from "lucide-react";
import { pluginsApi, type CompanyPluginActivation } from "@/api/plugins";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useToastActions } from "@/context/ToastContext";

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
  onToggle,
}: {
  plugin: PluginRecord;
  activation: CompanyPluginActivation | null;
  builtIn?: boolean;
  changing?: boolean;
  onToggle: () => void;
}) {
  const state = plugin.status === "ready" ? "Ready" : plugin.status;
  const companyEnabled = activation?.enabled ?? false;
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
            {companyEnabled ? "Enabled in this Company" : "Disabled in this Company"}
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
          disabled={plugin.status !== "ready" || changing}
          onClick={onToggle}
        >
          <Power className="h-4 w-4" />
          {companyEnabled ? "Disable" : "Enable"}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
            <Settings className="h-4 w-4" />
            {plugin.status === "upgrade_pending" ? "Review update" : "Settings"}
          </Link>
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
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      pluginsApi.setCompanyActivation(pluginId, selectedCompany!.id, enabled),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.companyActivation(selectedCompany!.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributionsPrefix });
      pushToast({
        title: variables.enabled ? "Extension enabled for this Company" : "Extension disabled for this Company",
        tone: variables.enabled ? "success" : "info",
      });
    },
    onError: (error: Error) => {
      pushToast({ title: "Could not change Company extension", body: error.message, tone: "error" });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "SPS" , href: "/dashboard" },
      { label: "Server settings", href: "/company/settings" },
      { label: "Extensions" },
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
  if (!selectedCompany) return <div className="p-4 text-sm text-muted-foreground">Select a Company to manage its extensions.</div>;
  if (companyPluginsQuery.isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading Company extensions...</div>;
  if (companyPluginsQuery.error) return <div className="p-4 text-sm text-destructive">Failed to load Company extension settings.</div>;

  const renderExtension = (plugin: PluginRecord, builtIn: boolean) => {
    const activation = activationByPluginId.get(plugin.id) ?? null;
    return (
      <ExtensionRow
        key={plugin.id}
        plugin={plugin}
        activation={activation}
        builtIn={builtIn}
        changing={activationMutation.isPending && activationMutation.variables?.pluginId === plugin.id}
        onToggle={() => activationMutation.mutate({ pluginId: plugin.id, enabled: !activation?.enabled })}
      />
    );
  };

  return (
    <div className="max-w-4xl space-y-6">
      <header className="flex items-start gap-3">
        <div className="rounded-md border bg-muted/40 p-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">SPS Extensions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Packages are installed once on this Host. Enable only the extensions this Company should use.
          </p>
        </div>
      </header>

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
              No Registry extensions are installed. Open the SPS Desktop menu and choose <strong>Manage Plugin Registries...</strong> to review a trusted source.
            </CardContent>
          )}
        </Card>
      </section>
    </div>
  );
}
