import { lazy, Suspense, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useMatch, useParams } from "@/lib/router";
import { workspaceSurfacesApi } from "@/api/workspace-surfaces";
import { useCompany } from "@/context/CompanyContext";
import { shouldSyncCompanySelectionFromRoute } from "@/lib/company-selection";
import { normalizeCompanyPrefix } from "@/lib/company-routes";
import { queryKeys } from "@/lib/queryKeys";
import { isSpsBasicModeEnabled } from "@/lib/sps-basic-mode";
import { isSpsCoreBaselineModeEnabled } from "@/lib/sps-core-baseline-mode";
import { isWorkplaneModeEnabled } from "@/lib/workplane-mode";
import { workspaceShellRoute } from "@/lib/workspace-shell-route";
import { SpsEmptyWorkspace } from "@/pages/SpsEmptyWorkspace";
import { NotFoundPage } from "@/pages/NotFound";

const CompatibilityLayout = lazy(() => import("./Layout").then((module) => ({ default: module.Layout })));

function WorkspaceLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-sm text-muted-foreground" role="status">
      Loading workspace...
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
  const independentEntry = Boolean(root) && isSpsBasicModeEnabled() && isSpsCoreBaselineModeEnabled() && !isWorkplaneModeEnabled();
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      {independentEntry ? <SpsWorkspaceEntry /> : <CompatibilityLayout />}
    </Suspense>
  );
}
