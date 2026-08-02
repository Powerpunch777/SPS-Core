import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Puzzle, ArrowLeft, ShieldAlert, ShieldCheck, ActivitySquare, CheckCircle, XCircle, Loader2, Clock, Cpu, Webhook, CalendarClock, AlertTriangle, FolderOpen, Save } from "lucide-react";
import type { PluginLocalFolderDeclaration, PluginRecord } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, Navigate, useParams } from "@/lib/router";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { pluginsApi, type PluginDatabaseMigrationPlan, type PluginLocalFolderStatus } from "@/api/plugins";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChoosePathButton } from "@/components/PathInstructionsModal";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  JsonSchemaForm,
  validateJsonSchemaForm,
  getDefaultValues,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";

/**
 * PluginSettings page component.
 *
 * Detailed settings and diagnostics page for a single installed plugin.
 * Navigated to from {@link PluginManager} via the Settings gear icon.
 *
 * Displays:
 * - Plugin identity: display name, id, version, description, categories.
 * - Manifest-declared capabilities (what data and features the plugin can access).
 * - Health check results (only for `ready` plugins; polled every 30 seconds).
 * - Runtime dashboard: worker status/uptime, recent job runs, webhook deliveries.
 * - Auto-generated config form from `instanceConfigSchema` (when no custom settings page).
 * - Plugin-contributed settings UI via `<PluginSlotOutlet type="settingsPage" />`.
 *
 * Data flow:
 * - `GET /api/plugins/:pluginId` — plugin record (refreshes on mount).
 * - `GET /api/plugins/:pluginId/health` — health diagnostics (polling).
 *   Only fetched when `plugin.status === "ready"`.
 * - `GET /api/plugins/:pluginId/dashboard` — aggregated runtime dashboard data (polling).
 * - `GET /api/plugins/:pluginId/config` — current config values.
 * - `POST /api/plugins/:pluginId/config` — save config values.
 * - `POST /api/plugins/:pluginId/config/test` — test configuration.
 *
 * URL params:
 * - `companyPrefix` — the company slug (for breadcrumb links).
 * - `pluginId` — UUID of the plugin to display.
 *
 * @see PluginManager — parent list page.
 * @see doc/plugins/PLUGIN_SPEC.md §13 — Plugin Health Checks.
 * @see doc/plugins/PLUGIN_SPEC.md §19.8 — Plugin Settings UI.
 */
export function PluginSettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyPrefix, pluginId } = useParams<{ companyPrefix?: string; pluginId: string }>();
  const [activeTab, setActiveTab] = useState<"configuration" | "status">("configuration");
  const coreBaselineMode = isSpsCoreBaselineModeEnabled();

  const { data: plugin, isLoading: pluginLoading } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId!),
    queryFn: () => pluginsApi.get(pluginId!),
    enabled: !!pluginId,
  });

  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: queryKeys.plugins.health(pluginId!),
    queryFn: () => pluginsApi.health(pluginId!),
    enabled: !!pluginId && plugin?.status === "ready",
    refetchInterval: 30000,
  });

  const { data: dashboardData } = useQuery({
    queryKey: queryKeys.plugins.dashboard(pluginId!),
    queryFn: () => pluginsApi.dashboard(pluginId!),
    enabled: !!pluginId,
    refetchInterval: 30000,
  });

  const { data: recentLogs } = useQuery({
    queryKey: queryKeys.plugins.logs(pluginId!),
    queryFn: () => pluginsApi.logs(pluginId!, { limit: 50 }),
    enabled: !!pluginId && plugin?.status === "ready",
    refetchInterval: 30000,
  });

  // Fetch existing config for the plugin
  const configSchema = plugin?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  const hasConfigSchema = configSchema && configSchema.properties && Object.keys(configSchema.properties).length > 0;

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId!),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId && !!hasConfigSchema,
  });

  const { slots } = usePluginSlots({
    slotTypes: ["settingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  // Filter slots to only show settings pages for this specific plugin
  const pluginSlots = slots.filter((slot) => slot.pluginId === pluginId);

  // If the plugin has a custom settingsPage slot, prefer that over auto-generated form
  const hasCustomSettingsPage = pluginSlots.length > 0;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? (coreBaselineMode ? "Workspace" : "Company"), href: "/dashboard" },
      { label: coreBaselineMode ? "Host settings" : "Settings", href: "/company/settings" },
      { label: "Plugins", href: "/company/settings/instance/plugins" },
      { label: plugin?.manifestJson?.displayName ?? plugin?.packageName ?? "Plugin Details" },
    ]);
  }, [coreBaselineMode, selectedCompany?.name, setBreadcrumbs, companyPrefix, plugin]);

  useEffect(() => {
    setActiveTab("configuration");
  }, [pluginId]);

  if (pluginLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading plugin details...</div>;
  }

  if (!plugin) {
    return <Navigate to="/company/settings/instance/plugins" replace />;
  }

  const displayStatus = plugin.status;
  const statusVariant =
    plugin.status === "ready"
      ? "default"
      : plugin.status === "error"
        ? "destructive"
        : "secondary";
  const pluginDescription = plugin.manifestJson.description || "No description provided.";
  const pluginCapabilities = plugin.manifestJson.capabilities ?? [];
  const environmentDrivers = plugin.manifestJson.environmentDrivers ?? [];
  const localFolderDeclarations = plugin.manifestJson.localFolders ?? [];
  const hasLocalFolders = localFolderDeclarations.length > 0;
  const hasExplicitAgentToolAccess = plugin.manifestJson.agentToolAccess === "explicit_grant";
  const hasMemoryProvider = !!plugin.manifestJson.memoryProvider;
  const environmentDriverNames = environmentDrivers
    .map((driver) => driver.displayName?.trim() || driver.driverKey)
    .filter((name, index, values) => values.indexOf(name) === index);
  const driverLabel = environmentDriverNames.join(", ");

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Link to="/company/settings/instance/plugins">
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{plugin.manifestJson.displayName ?? plugin.packageName}</h1>
          <Badge variant={statusVariant} className="ml-2">
            {displayStatus}
          </Badge>
          <Badge variant="outline" className="ml-1">
            v{plugin.manifestJson.version ?? plugin.version}
          </Badge>
        </div>
      </div>

      {plugin.status === "upgrade_pending" ? <PluginUpdateReview plugin={plugin} /> : null}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "configuration" | "status")} className="space-y-6">
        <PageTabBar
          align="start"
          items={[
            { value: "configuration", label: "Configuration" },
            { value: "status", label: "Status" },
          ]}
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "configuration" | "status")}
        />

        <TabsContent value="configuration" className="space-y-6">
          <div className="space-y-8">
            <section className="space-y-5">
              <h2 className="text-base font-semibold">About</h2>
              <div className="grid gap-8 lg:grid-cols-(--gtc-52)">
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
                  <p className="text-sm leading-6 text-foreground/90">{pluginDescription}</p>
                </div>
                <div className="space-y-4 text-sm">
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-muted-foreground">Author</h3>
                    <p className="text-foreground">{plugin.manifestJson.author}</p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-medium text-muted-foreground">Categories</h3>
                    <div className="flex flex-wrap gap-2">
                      {plugin.categories.length > 0 ? (
                        plugin.categories.map((category) => (
                          <Badge key={category} variant="outline" className="capitalize">
                            {category}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-foreground">None</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">Settings</h2>
              </div>
              {hasLocalFolders && coreBaselineMode ? (
                <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">This plugin uses legacy folder declarations.</p>
                  <p className="mt-1 text-muted-foreground">
                    SPS Core keeps Host-managed files in Workspace Sources. Use a Profile 2.0 version of this plugin to request a Source route instead of configuring a raw local folder here.
                  </p>
                  <div className="mt-3">
                    <Link to="/company/settings/project-sources">
                      <Button variant="outline" size="sm">Open Sources</Button>
                    </Link>
                  </div>
                </div>
              ) : hasLocalFolders ? (
                <PluginLocalFoldersSettings
                  pluginId={pluginId!}
                  companyId={selectedCompanyId}
                  declarations={localFolderDeclarations}
                />
              ) : null}
              {hasExplicitAgentToolAccess ? (
                <PluginToolAccessSettings
                  pluginId={pluginId!}
                  companyId={selectedCompanyId}
                />
              ) : null}
              {hasMemoryProvider ? (
                <PluginMemoryProviderSettings
                  pluginId={pluginId!}
                  providerKey={plugin.manifestJson.memoryProvider!.providerKey}
                  companyId={selectedCompanyId}
                />
              ) : null}
              {hasCustomSettingsPage ? (
                <div className="space-y-3">
                  {pluginSlots.map((slot) => (
                    <PluginSlotMount
                      key={`${slot.pluginKey}:${slot.id}`}
                      slot={slot}
                      context={{
                        companyId: selectedCompanyId,
                        companyPrefix: companyPrefix ?? null,
                      }}
                      missingBehavior="placeholder"
                    />
                  ))}
                </div>
              ) : hasConfigSchema ? (
                <PluginConfigForm
                  pluginId={pluginId!}
                  schema={configSchema!}
                  initialValues={configData?.configJson}
                  isLoading={configLoading}
                  pluginStatus={plugin.status}
                  supportsConfigTest={(plugin as unknown as { supportsConfigTest?: boolean }).supportsConfigTest === true}
                />
              ) : environmentDrivers.length > 0 && coreBaselineMode ? (
                <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">This plugin requires a legacy environment configuration surface.</p>
                  <p className="mt-1 text-muted-foreground">
                    SPS Core does not expose instance-scoped environments. Use a Profile 2.0 compatible version of this plugin, or configure a plugin-provided settings page.
                  </p>
                </div>
              ) : environmentDrivers.length > 0 ? (
                <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">Configure this plugin from Instance Settings → Environments.</p>
                  <p className="mt-1 text-muted-foreground">
                    {driverLabel || "This plugin"} registers environment runtime settings there so the execution target
                    stays instance-scoped while secret bindings still resolve through the selected company context.
                  </p>
                  <div className="mt-3">
                    <Link to="/company/settings/instance/environments">
                      <Button variant="outline" size="sm">Open Environments</Button>
                    </Link>
                  </div>
                </div>
              ) : !hasLocalFolders && !hasExplicitAgentToolAccess && !hasMemoryProvider ? (
                <p className="text-sm text-muted-foreground">
                  This plugin does not require any settings.
                </p>
              ) : null}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="status" className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-(--gtc-39)">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <Cpu className="h-4 w-4" />
                    Runtime Dashboard
                  </CardTitle>
                  <CardDescription>
                    Worker process, scheduled jobs, and webhook deliveries
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {dashboardData ? (
                    <>
                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                          Worker Process
                        </h3>
                        {dashboardData.worker ? (
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Status</span>
                              <Badge variant={dashboardData.worker.status === "running" ? "default" : "secondary"}>
                                {dashboardData.worker.status}
                              </Badge>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">PID</span>
                              <span className="font-mono text-xs">{dashboardData.worker.pid ?? "—"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Uptime</span>
                              <span className="text-xs">{formatUptime(dashboardData.worker.uptime)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">Pending RPCs</span>
                              <span className="text-xs">{dashboardData.worker.pendingRequests}</span>
                            </div>
                            {dashboardData.worker.totalCrashes > 0 && (
                              <>
                                <div className="flex justify-between col-span-2">
                                  <span className="text-muted-foreground flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                                    Crashes
                                  </span>
                                  <span className="text-xs">
                                    {dashboardData.worker.consecutiveCrashes} consecutive / {dashboardData.worker.totalCrashes} total
                                  </span>
                                </div>
                                {dashboardData.worker.lastCrashAt && (
                                  <div className="flex justify-between col-span-2">
                                    <span className="text-muted-foreground">Last Crash</span>
                                    <span className="text-xs">{formatTimestamp(dashboardData.worker.lastCrashAt)}</span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">No worker process registered.</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                          Recent Job Runs
                        </h3>
                        {dashboardData.recentJobRuns.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentJobRuns.map((run) => (
                              <div
                                key={run.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <JobStatusDot status={run.status} />
                                  <span className="truncate font-mono text-xs" title={run.jobKey ?? run.jobId}>
                                    {run.jobKey ?? run.jobId.slice(0, 8)}
                                  </span>
                                  <Badge variant="outline" className="px-1 py-0 text-(length:--text-nano)">
                                    {run.trigger}
                                  </Badge>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {run.durationMs != null ? <span>{formatDuration(run.durationMs)}</span> : null}
                                  <span title={run.createdAt}>{formatRelativeTime(run.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">No job runs recorded yet.</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                          Recent Webhook Deliveries
                        </h3>
                        {dashboardData.recentWebhookDeliveries.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentWebhookDeliveries.map((delivery) => (
                              <div
                                key={delivery.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <DeliveryStatusDot status={delivery.status} />
                                  <span className="truncate font-mono text-xs" title={delivery.webhookKey}>
                                    {delivery.webhookKey}
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {delivery.durationMs != null ? <span>{formatDuration(delivery.durationMs)}</span> : null}
                                  <span title={delivery.createdAt}>{formatRelativeTime(delivery.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">No webhook deliveries recorded yet.</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Last checked: {new Date(dashboardData.checkedAt).toLocaleTimeString()}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Runtime diagnostics are unavailable right now.
                    </p>
                  )}
                </CardContent>
              </Card>

              {recentLogs && recentLogs.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-1.5">
                      <ActivitySquare className="h-4 w-4" />
                      Recent Logs
                    </CardTitle>
                    <CardDescription>Last {recentLogs.length} log entries</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                      {recentLogs.map((entry) => (
                        <div
                          key={entry.id}
                          className={`flex gap-2 py-0.5 ${
                            entry.level === "error"
                              ? "text-destructive"
                              : entry.level === "warn"
                                ? "text-yellow-600 dark:text-yellow-400"
                                : entry.level === "debug"
                                  ? "text-muted-foreground/60"
                                  : "text-muted-foreground"
                          }`}
                        >
                          <span className="shrink-0 text-muted-foreground/50">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-(length:--text-nano)">{entry.level}</Badge>
                          <span className="truncate" title={entry.message}>{entry.message}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ActivitySquare className="h-4 w-4" />
                    Health Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {healthLoading ? (
                    <p className="text-sm text-muted-foreground">Checking health...</p>
                  ) : healthData ? (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Overall</span>
                        <Badge variant={healthData.healthy ? "default" : "destructive"}>
                          {healthData.status}
                        </Badge>
                      </div>

                      {healthData.checks.length > 0 ? (
                        <div className="space-y-2 border-t border-border/50 pt-2">
                          {healthData.checks.map((check, i) => (
                            <div key={i} className="flex items-start justify-between gap-2">
                              <span className="truncate text-muted-foreground" title={check.name}>
                                {check.name}
                              </span>
                              {check.passed ? (
                                <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
                              ) : (
                                <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {healthData.lastError ? (
                        <div className="break-words rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                          {healthData.lastError}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span>Lifecycle</span>
                        <Badge variant={statusVariant}>{displayStatus}</Badge>
                      </div>
                      <p>Health checks run once the plugin is ready.</p>
                      {plugin.lastError ? (
                        <div className="break-words rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                          {plugin.lastError}
                        </div>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <span>Plugin ID</span>
                    <span className="font-mono text-xs text-right">{plugin.id}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Plugin Key</span>
                    <span className="font-mono text-xs text-right">{plugin.pluginKey}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>NPM Package</span>
                    <span className="max-w-(--sz-170px) truncate text-right text-xs" title={plugin.packageName}>
                      {plugin.packageName}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Version</span>
                    <span className="text-right text-foreground">v{plugin.manifestJson.version ?? plugin.version}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" />
                    Permissions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {pluginCapabilities.length > 0 ? (
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {pluginCapabilities.map((cap) => (
                        <li key={cap} className="rounded-md bg-muted/40 px-2.5 py-2 font-mono text-xs text-foreground/85">
                          {cap}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No special permissions requested.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PluginLocalFoldersSettings — host-managed company-scoped folders
// ---------------------------------------------------------------------------

function pendingReviewTargetVersion(lastError: string | null): string | undefined {
  const match = lastError?.match(/target version:\s*([^;\n]+)/i);
  return match?.[1]?.trim() || undefined;
}

function pendingReviewCapabilities(lastError: string | null): string[] {
  const match = lastError?.match(/new capabilities:\s*([^;\n]+)/i);
  return match?.[1]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
}

function PluginUpdateReview({ plugin }: { plugin: PluginRecord }) {
  const queryClient = useQueryClient();
  const [dataMigrationApproved, setDataMigrationApproved] = useState(false);
  const [capabilityApproved, setCapabilityApproved] = useState(false);
  const pendingUpdateQuery = useQuery({
    queryKey: queryKeys.plugins.pendingUpdate(plugin.id),
    queryFn: () => pluginsApi.pendingUpdate(plugin.id),
    enabled: plugin.status === "upgrade_pending",
  });
  const migrationPlanQuery = useQuery({
    queryKey: queryKeys.plugins.migrationPlan(plugin.id),
    queryFn: () => pluginsApi.migrationPlan(plugin.id),
    enabled: plugin.status === "upgrade_pending",
  });
  const pendingUpdate = pendingUpdateQuery.data;
  const targetVersion = pendingUpdate?.targetVersion ?? pendingReviewTargetVersion(plugin.lastError);
  const capabilityEscalations = pendingUpdate?.addedCapabilities ?? pendingReviewCapabilities(plugin.lastError);
  const migrationPlan = migrationPlanQuery.data;
  const requiresDataMigrationApproval = migrationPlan?.requiresHostApproval === true;
  const canApprove =
    !pendingUpdateQuery.isLoading &&
    !pendingUpdateQuery.isError &&
    !migrationPlanQuery.isLoading &&
    !migrationPlanQuery.isError &&
    (!requiresDataMigrationApproval || dataMigrationApproved) &&
    (capabilityEscalations.length === 0 || capabilityApproved);

  const approveMutation = useMutation({
    mutationFn: () =>
      pluginsApi.upgrade(plugin.id, {
        version: targetVersion,
        ...((pendingUpdate?.stageId ?? migrationPlan?.registryStageId)
          ? { stageId: pendingUpdate?.stageId ?? migrationPlan?.registryStageId }
          : {}),
        approvedCapabilityEscalation: capabilityEscalations.length > 0 ? capabilityApproved : undefined,
        approvedDataMigrationPlanHash: requiresDataMigrationApproval ? migrationPlan?.reviewHash : undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.detail(plugin.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.migrationPlan(plugin.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.pendingUpdate(plugin.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributionsPrefix });
    },
  });

  return (
    <Card className="border-amber-500/35 bg-amber-500/[0.05]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" />
          Update review required
        </CardTitle>
        <CardDescription>
          This update is stopped until the Host reviews its requested changes. No worker is running while it is pending.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {targetVersion ? (
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-background/60 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Candidate version</span>
            <span className="font-mono">v{targetVersion}</span>
          </div>
        ) : null}

        {pendingUpdate ? (
          <p className="text-xs text-muted-foreground">
            Registry candidate from {pendingUpdate.source.registryId} is pinned to this review. Approval applies only to this exact staged package.
          </p>
        ) : null}

        {capabilityEscalations.length > 0 ? (
          <div className="space-y-3 rounded-md border border-border/70 bg-background/60 p-3">
            <div>
              <h3 className="text-sm font-medium">New capabilities</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                The updated plugin asks the Host for access it did not have before.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {capabilityEscalations.map((capability) => (
                <Badge key={capability} variant="outline" className="font-mono text-xs">
                  {capability}
                </Badge>
              ))}
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={`approve-capabilities-${plugin.id}`}
                checked={capabilityApproved}
                onCheckedChange={(value) => setCapabilityApproved(value === true)}
              />
              <Label htmlFor={`approve-capabilities-${plugin.id}`} className="cursor-pointer text-sm leading-5">
                I reviewed and approve these additional capabilities for this update.
              </Label>
            </div>
          </div>
        ) : null}

        {migrationPlanQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading requested database changes...
          </div>
        ) : migrationPlanQuery.isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
            The database change review could not be loaded. Approval stays disabled until this check succeeds.
          </div>
        ) : migrationPlan ? (
          <MigrationPlanReview
            pluginId={plugin.id}
            plan={migrationPlan}
            approved={dataMigrationApproved}
            onApprovedChange={setDataMigrationApproved}
          />
        ) : (
          <div className="rounded-md border border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
            This update does not declare plugin-owned database changes.
          </div>
        )}

        {plugin.lastError ? <p className="text-xs text-muted-foreground">{plugin.lastError}</p> : null}

        {approveMutation.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
            {approveMutation.error.message || "The reviewed update could not be applied."}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            When database changes are approved, SPS creates a fresh Host database backup immediately before the update runs.
          </p>
          <Button onClick={() => approveMutation.mutate()} disabled={!canApprove || approveMutation.isPending}>
            {approveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Approve and apply update
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MigrationPlanReview({
  pluginId,
  plan,
  approved,
  onApprovedChange,
}: {
  pluginId: string;
  plan: PluginDatabaseMigrationPlan;
  approved: boolean;
  onApprovedChange: (approved: boolean) => void;
}) {
  if (!plan.requiresHostApproval) {
    return (
      <div className="rounded-md border border-border/70 bg-background/60 px-3 py-3 text-sm text-muted-foreground">
        The plugin database is new or there are no pending database changes. No database approval is required.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-background/60 p-3">
      <div>
        <h3 className="text-sm font-medium">Plugin database changes</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan.pendingMigrations.length} migration file{plan.pendingMigrations.length === 1 ? "" : "s"} will change this plugin's private data namespace.
        </p>
      </div>
      <div className="space-y-2">
        {plan.pendingMigrations.map((migration) => (
          <div key={migration.migrationKey} className="rounded border border-border/60 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-foreground">{migration.migrationKey}</span>
              <span className="text-xs text-muted-foreground">{migration.statementCount} SQL statement{migration.statementCount === 1 ? "" : "s"}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {migration.operationKinds.map((operation) => (
                <Badge key={operation} variant="outline" className="text-xs capitalize">{operation}</Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`approve-migrations-${pluginId}`}
          checked={approved}
          onCheckedChange={(value) => onApprovedChange(value === true)}
        />
        <Label htmlFor={`approve-migrations-${pluginId}`} className="cursor-pointer text-sm leading-5">
          I reviewed these database changes and understand SPS will create a Host backup first.
        </Label>
      </div>
      <p className="font-mono text-xs text-muted-foreground">Review hash: {plan.reviewHash}</p>
    </div>
  );
}

function PluginToolAccessSettings({ pluginId, companyId }: { pluginId: string; companyId: string | null }) {
  const queryClient = useQueryClient();
  const { data: access, isLoading: accessLoading, error: accessError } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.toolGrants(pluginId, companyId)
      : ["plugins", pluginId, "companies", "none", "tool-grants"],
    queryFn: () => pluginsApi.getToolGrants(pluginId, companyId!),
    enabled: !!companyId,
  });
  const { data: auditData } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.toolAudit(pluginId, companyId)
      : ["plugins", pluginId, "companies", "none", "tool-audit"],
    queryFn: () => pluginsApi.listToolAudit(pluginId, companyId!, 12),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });
  const { data: agents = [], isLoading: agentsLoading, error: agentsError } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const updateGrant = useMutation({
    mutationFn: ({ agentId, enabled }: { agentId: string; enabled: boolean }) =>
      pluginsApi.setToolGrant(pluginId, companyId!, agentId, enabled),
    onSuccess: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.toolGrants(pluginId, companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.toolAudit(pluginId, companyId) });
    },
  });

  if (!companyId) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        Select a company to manage Agent tool access.
      </div>
    );
  }

  const grantedAgentIds = new Set(
    (access?.grants ?? []).filter((grant) => grant.revokedAt === null).map((grant) => grant.agentId),
  );
  const activeAgents = agents.filter((agent) => agent.status !== "terminated");
  const loadError = accessError ?? agentsError;

  return (
    <div className="space-y-4 rounded-md border border-border/70 bg-background px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Agent tool access
          </h3>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            This plugin requires an explicit grant. Only enabled Agents can invoke its tools; every outcome is recorded without tool parameters.
          </p>
        </div>
        <Badge variant="outline">Explicit grant</Badge>
      </div>

      {loadError ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(loadError as Error).message || "Failed to load Agent access settings."}
        </div>
      ) : null}

      {accessLoading || agentsLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Agent grants...
        </div>
      ) : activeAgents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active Agents are available in this company.</p>
      ) : (
        <div className="divide-y divide-border/60 rounded-md border border-border/60">
          {activeAgents.map((agent) => {
            const granted = grantedAgentIds.has(agent.id);
            const pending = updateGrant.isPending && updateGrant.variables?.agentId === agent.id;
            return (
              <div key={agent.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{agent.title || agent.role}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">{granted ? "Allowed" : "Blocked"}</span>
                  <ToggleSwitch
                    checked={granted}
                    disabled={pending || updateGrant.isPending}
                    onCheckedChange={(enabled) => updateGrant.mutate({ agentId: agent.id, enabled })}
                    aria-label={`${granted ? "Revoke" : "Grant"} ${agent.name} tool access`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {updateGrant.error ? (
        <p className="text-sm text-destructive">{(updateGrant.error as Error).message || "Failed to update Agent access."}</p>
      ) : null}

      <div className="space-y-2 border-t border-border/60 pt-4">
        <h4 className="text-sm font-medium">Recent tool audit</h4>
        {(auditData?.audit ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No tool calls have been recorded for this company.</p>
        ) : (
          <div className="space-y-1.5">
            {auditData!.audit.map((entry) => {
              const agent = agents.find((candidate) => candidate.id === entry.agentId);
              const variant = entry.status === "succeeded" ? "default" : entry.status === "denied" ? "secondary" : "destructive";
              return (
                <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium">{agent?.name ?? entry.agentId}</span>
                    <span className="mx-1.5 text-muted-foreground">used</span>
                    <span className="font-mono">{entry.toolName}</span>
                    {entry.error ? <span className="ml-1.5 text-destructive">{entry.error}</span> : null}
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Badge variant={variant}>{entry.status}</Badge>
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PluginMemoryProviderSettings({
  pluginId,
  providerKey,
  companyId,
}: {
  pluginId: string;
  providerKey: string;
  companyId: string | null;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.memoryProvider(companyId)
      : ["plugins", "companies", "none", "memory-provider"],
    queryFn: () => pluginsApi.getMemoryProvider(companyId!),
    enabled: !!companyId,
  });
  const { data: deliveriesData } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.memoryDeliveries(companyId)
      : ["plugins", "companies", "none", "memory-provider", "deliveries"],
    queryFn: () => pluginsApi.listMemoryDeliveries(companyId!, 12),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });
  const setProvider = useMutation({
    mutationFn: (nextProviderKey: string | null) => pluginsApi.setMemoryProvider(companyId!, nextProviderKey),
    onSuccess: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.memoryProvider(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.memoryDeliveries(companyId) });
    },
  });

  if (!companyId) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        Select a company to configure its memory provider.
      </div>
    );
  }

  const selection = data?.selection;
  const selectedHere = selection?.status === "enabled" && selection.provider?.pluginId === pluginId;
  const provider = data?.providers.find((candidate) => candidate.pluginId === pluginId);
  const deliveries = (deliveriesData?.deliveries ?? []).filter((delivery) => delivery.providerPluginId === pluginId);

  return (
    <div className="space-y-4 rounded-md border border-border/70 bg-background px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Company memory provider</h3>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            The Core selects one lifecycle-memory provider per company. Memory content stays in the selected provider; this view stores only operational metadata.
          </p>
        </div>
        <Badge variant={selectedHere ? "default" : "outline"}>{selectedHere ? "Active" : "Available"}</Badge>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message || "Failed to load memory provider settings."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading memory provider...
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{provider?.displayName ?? providerKey}</p>
              <p className="text-xs text-muted-foreground">
                {selectedHere
                  ? `Selected for this company (${selection?.source ?? "configured"}).`
                  : selection?.status === "disabled"
                    ? "Company memory is currently disabled."
                    : selection?.source === "unavailable"
                      ? `Configured provider ${selection.configuredProviderKey ?? "unknown"} is unavailable. Select a ready provider to resume memory.`
                    : `Current provider: ${selection?.provider?.displayName ?? "none"}.`}
              </p>
            </div>
            <Button
              size="sm"
              variant={selectedHere ? "outline" : "default"}
              disabled={setProvider.isPending || !provider}
              onClick={() => setProvider.mutate(selectedHere ? null : providerKey)}
            >
              {setProvider.isPending ? "Saving..." : selectedHere ? "Disable memory" : "Use this provider"}
            </Button>
          </div>

          {selection?.lastError ? (
            <p className="text-sm text-destructive">Latest lifecycle delivery failed: {selection.lastError}</p>
          ) : null}
          {setProvider.error ? (
            <p className="text-sm text-destructive">{(setProvider.error as Error).message || "Failed to change the memory provider."}</p>
          ) : null}

          <div className="space-y-2 border-t border-border/60 pt-4">
            <h4 className="text-sm font-medium">Recent lifecycle delivery</h4>
            {deliveries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No lifecycle events have been delivered to this provider yet.</p>
            ) : (
              <div className="space-y-1.5">
                {deliveries.map((delivery) => (
                  <div key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <span className="font-mono">{delivery.eventType}</span>
                      {delivery.error ? <span className="ml-1.5 text-destructive">{delivery.error}</span> : null}
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Badge variant={delivery.status === "delivered" ? "default" : delivery.status === "failed" ? "destructive" : "secondary"}>{delivery.status}</Badge>
                      <span>{new Date(delivery.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface PluginLocalFoldersSettingsProps {
  pluginId: string;
  companyId: string | null;
  declarations: PluginLocalFolderDeclaration[];
}

function PluginLocalFoldersSettings({ pluginId, companyId, declarations }: PluginLocalFoldersSettingsProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.localFolders(pluginId, companyId)
      : ["plugins", pluginId, "companies", "none", "local-folders"],
    queryFn: () => pluginsApi.listLocalFolders(pluginId, companyId!),
    enabled: !!companyId,
  });

  const statusByKey = new Map((data?.folders ?? []).map((folder) => [folder.folderKey, folder]));

  if (!companyId) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        Select a company to configure this plugin's local folders.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Local folders</h3>
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message || "Failed to load local folder settings."}
        </div>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading local folders...
        </div>
      ) : (
        <div className="space-y-3">
          {declarations.map((declaration) => (
            <PluginLocalFolderRow
              key={declaration.folderKey}
              pluginId={pluginId}
              companyId={companyId}
              declaration={declaration}
              status={statusByKey.get(declaration.folderKey)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PluginLocalFolderRowProps {
  pluginId: string;
  companyId: string;
  declaration: PluginLocalFolderDeclaration;
  status?: PluginLocalFolderStatus;
}

function PluginLocalFolderRow({ pluginId, companyId, declaration, status }: PluginLocalFolderRowProps) {
  const queryClient = useQueryClient();
  const serverPath = status?.path ?? "";
  const [pathValue, setPathValue] = useState(serverPath);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setPathValue(serverPath);
    setMessage(null);
  }, [serverPath, declaration.folderKey]);

  const saveMutation = useMutation({
    mutationFn: (path: string) =>
      pluginsApi.configureLocalFolder(pluginId, companyId, declaration.folderKey, {
        path,
        access: declaration.access,
        requiredDirectories: declaration.requiredDirectories,
        requiredFiles: declaration.requiredFiles,
      }),
    onSuccess: (nextStatus) => {
      setMessage({
        type: nextStatus.healthy ? "success" : "error",
        text: nextStatus.healthy
          ? "Local folder saved."
          : "Local folder saved, but validation still needs attention.",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.localFolders(pluginId, companyId) });
    },
    onError: (err: Error) => {
      setMessage({ type: "error", text: err.message || "Failed to save local folder." });
    },
  });

  const trimmedPath = pathValue.trim();
  const isDirty = trimmedPath !== serverPath;
  const access = status?.access ?? declaration.access ?? "readWrite";

  const handleSave = useCallback(() => {
    if (!trimmedPath) {
      setMessage({ type: "error", text: "Local folder path is required." });
      return;
    }
    if (!isLikelyAbsolutePath(trimmedPath)) {
      setMessage({ type: "error", text: "Local folder must be a full absolute path." });
      return;
    }
    setMessage(null);
    saveMutation.mutate(trimmedPath);
  }, [saveMutation, trimmedPath]);

  return (
    <div className="space-y-4 rounded-md border border-border/70 bg-background px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">{declaration.displayName}</h4>
            <Badge variant="outline" className="font-mono text-(length:--text-nano)">
              {declaration.folderKey}
            </Badge>
            <Badge variant={status?.healthy ? "default" : "secondary"}>
              {status?.healthy ? "Healthy" : "Needs attention"}
            </Badge>
          </div>
          {declaration.description ? (
            <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
              {declaration.description}
            </p>
          ) : null}
        </div>
        <Badge variant={access === "readWrite" ? "default" : "outline"}>
          {access === "readWrite" ? "Read/write" : "Read only"}
        </Badge>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <FolderStatusMetric label="Configured" value={status?.configured ? "Yes" : "No"} ok={!!status?.configured} />
        <FolderStatusMetric label="Readable" value={status?.readable ? "Yes" : "No"} ok={!!status?.readable} />
        <FolderStatusMetric
          label="Writable"
          value={access === "read" ? "Not requested" : status?.writable ? "Yes" : "No"}
          ok={access === "read" || !!status?.writable}
        />
      </div>

      {status?.path ? (
        <div className="space-y-1 text-sm">
          <div className="text-xs font-medium text-muted-foreground">Configured path</div>
          <div className="break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs text-foreground">
            {status.path}
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`local-folder-${declaration.folderKey}`}>
          Local folder path
        </label>
        <div className="flex items-center gap-2">
          <input
            id={`local-folder-${declaration.folderKey}`}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-ring/20"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setMessage(null);
            }}
            placeholder="/absolute/path/to/folder"
          />
          <ChoosePathButton className="h-8" />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending || !isDirty}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      <FolderRequirements status={status} declaration={declaration} />

      {status?.problems?.length ? (
        <div className="space-y-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <div className="font-medium">Validation problems</div>
          <ul className="space-y-1">
            {status.problems.map((problem, index) => (
              <li key={`${problem.code}:${problem.path ?? ""}:${index}`}>
                {problem.message}
                {problem.path ? <span className="font-mono"> {problem.path}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

function FolderStatusMetric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-2">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant={ok ? "default" : "secondary"}>{value}</Badge>
    </div>
  );
}

function FolderRequirements({
  status,
  declaration,
}: {
  status?: PluginLocalFolderStatus;
  declaration: PluginLocalFolderDeclaration;
}) {
  const requiredDirectories = status?.requiredDirectories ?? declaration.requiredDirectories ?? [];
  const requiredFiles = status?.requiredFiles ?? declaration.requiredFiles ?? [];
  const missingDirectories = status?.missingDirectories ?? requiredDirectories;
  const missingFiles = status?.missingFiles ?? requiredFiles;
  const rootNotInspected = isRootNotInspected(status);

  if (requiredDirectories.length === 0 && requiredFiles.length === 0) return null;

  return (
    <div className="grid gap-3 text-sm md:grid-cols-2">
      <RequirementList
        title="Required directories"
        items={requiredDirectories}
        missingItems={missingDirectories}
        missingLabel="Missing directories"
        inspectionUnavailable={rootNotInspected}
      />
      <RequirementList
        title="Required files"
        items={requiredFiles}
        missingItems={missingFiles}
        missingLabel="Missing files"
        inspectionUnavailable={rootNotInspected}
      />
    </div>
  );
}

function isRootNotInspected(status?: PluginLocalFolderStatus) {
  if (!status?.configured || status.readable) return false;
  return status.problems.some((problem) =>
    problem.code === "missing" || problem.code === "not_readable" || problem.code === "not_directory"
  );
}

function RequirementList({
  title,
  items,
  missingItems,
  missingLabel,
  inspectionUnavailable,
}: {
  title: string;
  items: string[];
  missingItems: string[];
  missingLabel: string;
  inspectionUnavailable?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {inspectionUnavailable ? (
          <Badge variant="secondary" className="text-(length:--text-nano)">
            Not inspected
          </Badge>
        ) : missingItems.length > 0 ? (
          <Badge variant="destructive" className="text-(length:--text-nano)">
            {missingItems.length} missing
          </Badge>
        ) : (
          <Badge variant="outline" className="text-(length:--text-nano)">Present</Badge>
        )}
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => {
            const missing = missingItems.includes(item);
            return (
              <span
                key={item}
                className={`rounded border px-1.5 py-0.5 font-mono text-(length:--text-micro) ${
                  inspectionUnavailable
                    ? "border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300"
                    : missing
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-border bg-muted/50 text-foreground/80"
                }`}
              >
                {item}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">None declared.</p>
      )}
      {inspectionUnavailable ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">Configured root was not inspected.</p>
      ) : missingItems.length > 0 ? (
        <p className="text-xs text-destructive">{missingLabel}: {missingItems.join(", ")}</p>
      ) : null}
    </div>
  );
}

function isLikelyAbsolutePath(pathValue: string) {
  return (
    pathValue.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(pathValue) ||
    pathValue.startsWith("\\\\")
  );
}

// ---------------------------------------------------------------------------
// PluginConfigForm — auto-generated form for instanceConfigSchema
// ---------------------------------------------------------------------------

interface PluginConfigFormProps {
  pluginId: string;
  schema: JsonSchemaNode;
  initialValues?: Record<string, unknown>;
  isLoading?: boolean;
  /** Current plugin lifecycle status — "Test Configuration" only available when `ready`. */
  pluginStatus?: string;
  /** Whether the plugin worker implements `validateConfig`. */
  supportsConfigTest?: boolean;
}

/**
 * Inner component that manages form state, validation, save, and "Test Configuration"
 * for the auto-generated plugin config form.
 *
 * Separated from PluginSettings to isolate re-render scope — only the form
 * re-renders on field changes, not the entire page.
 */
function PluginConfigForm({ pluginId, schema, initialValues, isLoading, pluginStatus, supportsConfigTest }: PluginConfigFormProps) {
  const queryClient = useQueryClient();

  // Form values: start with saved values, fall back to schema defaults
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  }));

  // Sync when saved config loads asynchronously — only on first load so we
  // don't overwrite in-progress user edits if the query refetches (e.g. on
  // window focus).
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    if (initialValues && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      setValues({
        ...getDefaultValues(schema),
        ...initialValues,
      });
    }
  }, [initialValues, schema]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Dirty tracking: compare against initial values
  const isDirty = JSON.stringify(values) !== JSON.stringify({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.saveConfig(pluginId, configJson),
    onSuccess: () => {
      setSaveMessage({ type: "success", text: "Configuration saved." });
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config(pluginId) });
      // Clear success message after 3s
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message || "Failed to save configuration." });
    },
  });

  // Test configuration mutation
  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.testConfig(pluginId, configJson),
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", text: "Configuration test passed." });
      } else {
        setTestResult({ type: "error", text: result.message || "Configuration test failed." });
      }
    },
    onError: (err: Error) => {
      setTestResult({ type: "error", text: err.message || "Configuration test failed." });
    },
  });

  const handleChange = useCallback((newValues: Record<string, unknown>) => {
    setValues(newValues);
    // Clear field-level errors as the user types
    setErrors({});
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(() => {
    // Validate before saving
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    saveMutation.mutate(values);
  }, [schema, values, saveMutation]);

  const handleTestConnection = useCallback(() => {
    // Validate before testing
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setTestResult(null);
    testMutation.mutate(values);
  }, [schema, values, testMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <JsonSchemaForm
        schema={schema}
        values={values}
        onChange={handleChange}
        errors={errors}
        disabled={saveMutation.isPending}
      />

      {/* Status messages */}
      {saveMessage && (
        <div
          className={`text-sm p-2 rounded border ${
            saveMessage.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {saveMessage.text}
        </div>
      )}

      {testResult && (
        <div
          className={`text-sm p-2 rounded border ${
            testResult.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {testResult.text}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          size="sm"
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Configuration"
          )}
        </Button>
        {pluginStatus === "ready" && supportsConfigTest && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Configuration"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard helper components and formatting utilities
// ---------------------------------------------------------------------------

/**
 * Format an uptime value (in milliseconds) to a human-readable string.
 */
function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs == null) return "—";
  const totalSeconds = Math.floor(uptimeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format a duration in milliseconds to a compact display string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format an ISO timestamp to a relative time string (e.g., "2m ago").
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a unix timestamp (ms since epoch) to a locale string.
 */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/**
 * Status indicator dot for job run statuses.
 */
function JobStatusDot({ status }: { status: string }) {
  const colorClass =
    status === "success" || status === "succeeded"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "running"
          ? "bg-blue-500 animate-pulse"
          : status === "cancelled"
            ? "bg-gray-400"
            : "bg-amber-500"; // queued, pending
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${colorClass}`}
      title={status}
    />
  );
}

/**
 * Status indicator dot for webhook delivery statuses.
 */
function DeliveryStatusDot({ status }: { status: string }) {
  const colorClass =
    status === "processed" || status === "success"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "received"
          ? "bg-blue-500"
          : "bg-amber-500"; // pending
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${colorClass}`}
      title={status}
    />
  );
}
