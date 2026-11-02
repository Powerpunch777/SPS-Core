import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useMatch, useParams } from "@/lib/router";
import { pluginsApi } from "@/api/plugins";
import { workspaceSurfacesApi } from "@/api/workspace-surfaces";
import { useCompany } from "@/context/CompanyContext";
import { shouldSyncCompanySelectionFromRoute } from "@/lib/company-selection";
import { normalizeCompanyPrefix } from "@/lib/company-routes";
import { queryKeys } from "@/lib/queryKeys";
import { isSpsBasicModeEnabled } from "@/lib/sps-basic-mode";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";
import { isWorkplaneModeEnabled } from "@/lib/workplane-mode";
import { workspaceShellRoute } from "@/lib/workspace-shell-route";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { SpsEmptyWorkspace } from "@/pages/SpsEmptyWorkspace";
import { NotFoundPage } from "@/pages/NotFound";

const CompatibilityLayout = lazy(() => import("./Layout").then((module) => ({ default: module.Layout })));

export type SpsWorkspacePluginPageContext = {
  source: "sps-workspace-layout";
  companyId: string;
  contributions: Awaited<ReturnType<typeof pluginsApi.listUiContributions>>;
};

// These roots are explicit destinations in App.tsx's coreBaselineRoutes().
// Other roots, including plugin aliases such as tasks and agent-rooms, are
// resolved from declared page contributions instead of being reserved here.
const RESERVED_CORE_ROUTE_ROOTS = new Set(["assistants", "company", "dashboard", "inbox"]);

function workspacePluginRouteSegments(pathname: string, companyPrefix: string | undefined): string[] | null {
  if (!companyPrefix) return null;
  const [routePrefix, ...segments] = pathname.split("/").filter(Boolean);
  if (routePrefix?.toUpperCase() !== companyPrefix.toUpperCase()) return null;
  return segments;
}

function canResolveWorkspacePluginPage(pathname: string, companyPrefix: string | undefined): boolean {
  const segments = workspacePluginRouteSegments(pathname, companyPrefix);
  if (!segments?.length) return false;
  const routeRoot = segments[0]!.toLowerCase();
  if (routeRoot === "plugins") return segments.length === 1 || segments.length === 2;
  return !RESERVED_CORE_ROUTE_ROOTS.has(routeRoot);
}

function isDeclaredWorkspacePluginPage(
  pathname: string,
  companyPrefix: string | undefined,
  contributions: Awaited<ReturnType<typeof pluginsApi.listUiContributions>>,
): boolean {
  const segments = workspacePluginRouteSegments(pathname, companyPrefix);
  if (!segments?.length) return false;

  if (segments[0]!.toLowerCase() === "plugins" && segments.length === 2) {
    const pluginId = segments[1];
    return contributions.filter((contribution) => contribution.pluginId === pluginId
      && contribution.slots.some((slot) => slot.type === "page")).length === 1;
  }

  const routePath = segments[0]!;
  if (RESERVED_CORE_ROUTE_ROOTS.has(routePath.toLowerCase())) return false;
  const matches = contributions.filter((contribution) =>
    contribution.slots.some((slot) => slot.type === "page" && slot.routePath === routePath),
  );
  return matches.length === 1;
}

function WorkspaceLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-sm text-muted-foreground" role="status">
      Loading workspace...
    </main>
  );
}

function PluginPageLookupError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-sm" role="alert">
      <p>Plugin page could not be loaded.</p>
      <button type="button" onClick={onRetry} disabled={retrying}>Retry</button>
    </main>
  );
}

export function SpsWorkspaceEntry() {
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const location = useLocation();
  const { companies, loading, error, reloadCompanies, selectedCompanyId, selectionSource, setSelectedCompanyId } = useCompany();
  const company = companies.find((entry) => entry.issuePrefix.toUpperCase() === companyPrefix?.toUpperCase());
  const shell = useQuery({
    queryKey: queryKeys.workspaceSurfaces.shell(company?.id ?? ""),
    queryFn: () => workspaceSurfacesApi.getShell(company!.id),
    enabled: Boolean(company) && !loading && !error,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  const retrySelection = () => void shell.refetch();

  useEffect(() => {
    if (loading || error || !company) return;
    if (shouldSyncCompanySelectionFromRoute({ selectionSource, selectedCompanyId, routeCompanyId: company.id })) {
      setSelectedCompanyId(company.id, { source: "route_sync" });
    }
  }, [company, error, loading, selectedCompanyId, selectionSource, setSelectedCompanyId]);

  if (loading) return <WorkspaceLoading />;
  if (error) {
    return <SpsEmptyWorkspace workspaceName="Workspace" status="unavailable" onRetry={() => void reloadCompanies()} />;
  }
  if (!company) return <NotFoundPage scope="invalid_company_prefix" requestedPrefix={companyPrefix} />;

  const prefix = normalizeCompanyPrefix(company.issuePrefix);
  if (companyPrefix !== prefix) {
    return <Navigate to={`/${prefix}${location.search}${location.hash}`} replace />;
  }
  const pluginsHref = `/${prefix}/company/settings/instance/plugins`;
  // Never replace a failed or still-refreshing selection with cached plugin UI.
  if (shell.isError) {
    return <SpsEmptyWorkspace workspaceName={company.name} pluginsHref={pluginsHref} status="unavailable" onRetry={retrySelection} retrying={shell.isFetching} />;
  }
  if (shell.isPending || shell.isFetching) return <WorkspaceLoading />;
  if (shell.data?.mode === "plugin" && shell.data.shell) {
    const target = workspaceShellRoute(shell.data.shell.defaultRoute, prefix);
    return <Navigate to={target} replace />;
  }
  if (shell.data?.mode === "neutral") {
    return <SpsEmptyWorkspace workspaceName={company.name} pluginsHref={pluginsHref} selectionUnavailable={Boolean(shell.data.fallbackReason)} />;
  }
  return <SpsEmptyWorkspace workspaceName={company.name} pluginsHref={pluginsHref} status="unavailable" onRetry={retrySelection} />;
}

export function SpsWorkspaceLayout() {
  const root = useMatch({ path: "/:companyPrefix", end: true });
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const {
    companies,
    loading: companiesLoading,
    error: companiesError,
    selectedCompanyId,
    selectionSource,
    setSelectedCompanyId,
  } = useCompany();
  const independentMode = isSpsBasicModeEnabled() && isSpsCoreBaselineModeEnabled() && !isWorkplaneModeEnabled();
  const company = companies.find((entry) => entry.issuePrefix.toUpperCase() === companyPrefix?.toUpperCase());
  const canResolvePluginPage = independentMode
    && !root
    && !companiesLoading
    && !companiesError
    && Boolean(company)
    && canResolveWorkspacePluginPage(location.pathname, companyPrefix);
  const contributions = useQuery({
    queryKey: queryKeys.plugins.uiContributions(company?.id ?? null),
    queryFn: () => pluginsApi.listUiContributions(company!.id),
    enabled: canResolvePluginPage,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  const pluginPageRoute = canResolvePluginPage
    && contributions.isSuccess
    && !contributions.isFetching
    && isDeclaredWorkspacePluginPage(location.pathname, companyPrefix, contributions.data);

  useEffect(() => {
    if (!pluginPageRoute || !company || companyPrefix !== normalizeCompanyPrefix(company.issuePrefix)) return;
    if (shouldSyncCompanySelectionFromRoute({ selectionSource, selectedCompanyId, routeCompanyId: company.id })) {
      setSelectedCompanyId(company.id, { source: "route_sync" });
    }
  }, [company, companyPrefix, pluginPageRoute, selectedCompanyId, selectionSource, setSelectedCompanyId]);

  if (pluginPageRoute && company && companyPrefix !== normalizeCompanyPrefix(company.issuePrefix)) {
    const suffix = location.pathname.slice(`/${companyPrefix}`.length);
    return <Navigate to={`/${normalizeCompanyPrefix(company.issuePrefix)}${suffix}${location.search}${location.hash}`} replace />;
  }

  return (
    <Suspense fallback={<WorkspaceLoading />}>
      {root && independentMode ? <SpsWorkspaceEntry />
        : pluginPageRoute && company ? <main data-sps-plugin-surface="true" className="h-dvh min-h-0 w-full overflow-auto"><RouteErrorBoundary><Outlet context={{
          source: "sps-workspace-layout",
          companyId: company.id,
          contributions: contributions.data!,
        } satisfies SpsWorkspacePluginPageContext} /></RouteErrorBoundary></main>
          : canResolvePluginPage && (contributions.isPending || contributions.isFetching) ? <WorkspaceLoading />
            : canResolvePluginPage && contributions.isError ? <PluginPageLookupError onRetry={() => void contributions.refetch()} retrying={contributions.isFetching} />
            : <CompatibilityLayout />}
    </Suspense>
  );
}
