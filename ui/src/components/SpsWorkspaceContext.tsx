import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Box, Layers3, MonitorCog, PlugZap } from "lucide-react";
import { pluginsApi } from "@/api/plugins";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation } from "@/lib/router";
import { cn } from "@/lib/utils";

function resolveSurface(pathname: string) {
  if (pathname === "/dashboard" || pathname.endsWith("/dashboard")) {
    return { owner: "Core", label: "Dashboard" };
  }
  if (pathname === "/inbox" || pathname.endsWith("/inbox")) {
    return { owner: "Core", label: "Inbox" };
  }
  if (pathname.includes("/company/settings")) {
    return { owner: "Core", label: "Host settings" };
  }
  if (pathname.includes("/plugins/")) {
    return { owner: "Plugin", label: "Plugin surface" };
  }

  const routeLabel = pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ");
  return { owner: "Plugin", label: routeLabel || "Workspace surface" };
}

export function SpsWorkspaceContext() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const location = useLocation();
  const surface = useMemo(() => resolveSurface(location.pathname), [location.pathname]);
  const companyPlugins = useQuery({
    queryKey: queryKeys.plugins.companyActivation(selectedCompanyId ?? "none"),
    queryFn: () => pluginsApi.listForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });

  const activePlugins = companyPlugins.data?.plugins.filter((plugin) => plugin.activation.enabled) ?? [];
  const readyPlugins = activePlugins.filter((plugin) => plugin.status === "ready");
  const desktopConnected = typeof window !== "undefined" && "spsDesktopWorkspace" in window;

  return (
    <aside className="sps-workbench-context" aria-label="Workspace context">
      <header className="sps-workbench-context-header">
        <div>
          <p>Workspace context</p>
          <span>Live SPS state</span>
        </div>
        <span className="sps-workbench-status sps-workbench-status-success">
          <span aria-hidden="true" /> Live
        </span>
      </header>

      <div className="sps-workbench-context-scroll">
        <section className="sps-workbench-context-section" aria-labelledby="workspace-context-heading">
          <h2 id="workspace-context-heading">Current Workspace</h2>
          <dl className="sps-workbench-kv">
            <dt>Workspace</dt>
            <dd>{selectedCompany?.name ?? "Not selected"}</dd>
            <dt>Surface</dt>
            <dd>{surface.label}</dd>
            <dt>Owner</dt>
            <dd>
              <span className={cn(
                "sps-workbench-status",
                surface.owner === "Core" ? "sps-workbench-status-info" : "sps-workbench-status-neutral",
              )}>
                {surface.owner}
              </span>
            </dd>
          </dl>
        </section>

        <section className="sps-workbench-context-section" aria-labelledby="workspace-state-heading">
          <h2 id="workspace-state-heading">System state</h2>
          <div className="sps-workbench-state-list">
            <div>
              <MonitorCog aria-hidden="true" />
              <span><b>Desktop runtime</b><small>{desktopConnected ? "Connected" : "Unavailable"}</small></span>
            </div>
            <div>
              <PlugZap aria-hidden="true" />
              <span>
                <b>Workspace plugins</b>
                <small>{companyPlugins.isLoading ? "Loading..." : `${readyPlugins.length} of ${activePlugins.length} ready`}</small>
              </span>
            </div>
            <div>
              <Activity aria-hidden="true" />
              <span><b>Current surface</b><small>{surface.owner}-owned</small></span>
            </div>
          </div>
        </section>

        <section className="sps-workbench-context-section" aria-labelledby="active-extensions-heading">
          <h2 id="active-extensions-heading">Active extensions</h2>
          {companyPlugins.isError ? (
            <p className="sps-workbench-context-empty">Plugin state is temporarily unavailable.</p>
          ) : activePlugins.length > 0 ? (
            <div className="sps-workbench-extension-list">
              {activePlugins.slice(0, 5).map((plugin) => (
                <div key={plugin.id}>
                  <Box aria-hidden="true" />
                  <span><b>{plugin.displayName}</b><small>v{plugin.version} · {plugin.status}</small></span>
                </div>
              ))}
              {activePlugins.length > 5 ? <p>+{activePlugins.length - 5} more</p> : null}
            </div>
          ) : (
            <p className="sps-workbench-context-empty">No plugins are active in this Workspace.</p>
          )}
        </section>

        <section className="sps-workbench-context-section" aria-labelledby="core-contracts-heading">
          <h2 id="core-contracts-heading">Core contracts</h2>
          <ul className="sps-workbench-contracts">
            <li><Layers3 aria-hidden="true" /> Stable Workspace shell</li>
            <li><Layers3 aria-hidden="true" /> Plugin lifecycle and slots</li>
            <li><Layers3 aria-hidden="true" /> Host runtime and access</li>
          </ul>
        </section>
      </div>
    </aside>
  );
}
