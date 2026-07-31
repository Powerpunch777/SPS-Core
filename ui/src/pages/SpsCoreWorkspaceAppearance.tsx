import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LayoutTemplate, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import { workspaceSurfacesApi } from "@/api/workspace-surfaces";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const NEUTRAL_SHELL_VALUE = "__sps_neutral_core__";

function providerValue(pluginId: string, shellId: string) {
  return `${pluginId}:${shellId}`;
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SpsCoreWorkspaceAppearance() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? selectedCompany?.id ?? "";
  const [draft, setDraft] = useState(NEUTRAL_SHELL_VALUE);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Workspace appearance" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const shellQuery = useQuery({
    queryKey: queryKeys.workspaceSurfaces.shell(companyId),
    queryFn: () => workspaceSurfacesApi.getShell(companyId),
    enabled: Boolean(companyId),
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.workspaceSurfaces.shellProviders(companyId),
    queryFn: () => workspaceSurfacesApi.listShellProviders(companyId),
    enabled: Boolean(companyId),
  });

  const savedValue = shellQuery.data?.mode === "plugin" && shellQuery.data.providerPluginId && shellQuery.data.shell
    ? providerValue(shellQuery.data.providerPluginId, shellQuery.data.shell.id)
    : NEUTRAL_SHELL_VALUE;

  useEffect(() => {
    if (shellQuery.data) setDraft(savedValue);
  }, [savedValue, shellQuery.data]);

  const options = useMemo<RadioCardOption[]>(() => [
    {
      value: NEUTRAL_SHELL_VALUE,
      title: "Neutral Core Shell",
      description: "Use the standard SPS workspace navigation and recovery surfaces. This is the default until a Host explicitly chooses a plugin shell.",
    },
    ...(providersQuery.data ?? []).map((provider) => ({
      value: providerValue(provider.pluginId, provider.shell.id),
      title: provider.shell.displayName || provider.pluginDisplayName,
      description: provider.shell.defaultRoute
        ? `Provided by ${provider.pluginDisplayName}. Opens at ${provider.shell.defaultRoute}.`
        : `Provided by ${provider.pluginDisplayName}.`,
    })),
  ], [providersQuery.data]);

  const selectMutation = useMutation({
    mutationFn: async () => {
      if (draft === NEUTRAL_SHELL_VALUE) {
        return workspaceSurfacesApi.selectShell(companyId, { pluginId: null, shellId: null });
      }
      const provider = (providersQuery.data ?? []).find(
        (candidate) => providerValue(candidate.pluginId, candidate.shell.id) === draft,
      );
      if (!provider) throw new Error("Choose an active Shell provider before applying the Workspace appearance.");
      return workspaceSurfacesApi.selectShell(companyId, {
        pluginId: provider.pluginId,
        shellId: provider.shell.id,
      });
    },
    onSuccess: async () => {
      setNotice(draft === NEUTRAL_SHELL_VALUE
        ? "Neutral Core Shell is now active for this Workspace."
        : "Workspace Shell selection saved.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSurfaces.shell(companyId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSurfaces.shellProviders(companyId) });
    },
  });

  const isLoading = shellQuery.isLoading || providersQuery.isLoading;
  const error = shellQuery.error ?? providersQuery.error ?? selectMutation.error;
  const currentProviderName = shellQuery.data?.mode === "plugin"
    ? (providersQuery.data ?? []).find((provider) => provider.pluginId === shellQuery.data?.providerPluginId)?.pluginDisplayName ?? "Selected plugin Shell"
    : "Neutral Core Shell";

  if (!companyId) {
    return <div className="max-w-3xl text-sm text-muted-foreground">Select a Workspace to manage its appearance.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-1 py-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2"><LayoutTemplate className="h-5 w-5 text-muted-foreground" /><h1 className="text-xl font-semibold">Workspace appearance</h1></div>
          <p className="max-w-2xl text-sm text-muted-foreground">Choose the navigation shell for this Workspace. Installing or enabling a plugin never changes this selection automatically.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => { void shellQuery.refetch(); void providersQuery.refetch(); }} disabled={isLoading || selectMutation.isPending}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh
        </Button>
      </header>

      {shellQuery.data?.fallbackReason ? <Card className="border-amber-500/40 bg-amber-500/10 py-0"><CardContent className="flex gap-2 py-3 text-sm text-amber-950 dark:text-amber-100"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>SPS restored the Neutral Core Shell.</strong> {shellQuery.data.fallbackReason} Choose an available Shell below to make a new explicit selection.</span></CardContent></Card> : null}
      {error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{readError(error, "Workspace appearance could not be loaded or saved.")}</p> : null}
      {notice ? <p className="flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-200"><CheckCircle2 className="h-4 w-4" />{notice}</p> : null}

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="text-base">Active Shell</CardTitle>
          <CardDescription>{currentProviderName}. The fixed SPS recovery navigation remains available regardless of the chosen Shell.</CardDescription>
        </CardHeader>
      </Card>

      <Card className="py-0">
        <CardHeader>
          <CardTitle className="text-base">Choose Workspace Shell</CardTitle>
          <CardDescription>Only active plugins that declare a Workspace Shell appear here. The selection is per Workspace and changes only after you apply it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? <p className="text-sm text-muted-foreground">Loading available Shells...</p> : <RadioCardGroup value={draft} onValueChange={(value) => { setDraft(value); setNotice(null); }} options={options} ariaLabel="Workspace Shell" disabled={selectMutation.isPending} />}
          {!isLoading && options.length === 1 ? <p className="text-sm text-muted-foreground">No active plugin currently provides a Workspace Shell. Neutral Core Shell remains selected until a Host chooses otherwise.</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-xs text-muted-foreground">{draft === savedValue ? "No unapplied appearance change." : "This choice has not been applied yet."}</p>
            <Button type="button" onClick={() => selectMutation.mutate()} disabled={isLoading || selectMutation.isPending || draft === savedValue}>
              {selectMutation.isPending ? "Applying..." : "Apply Workspace Shell"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
