// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpsWorkspaceShellState } from "@/api/workspace-surfaces";

const mocks = vi.hoisted(() => ({ shell: vi.fn(), contributions: vi.fn(), legacy: vi.fn(), select: vi.fn(), reload: vi.fn() }));
const companyState = vi.hoisted(() => ({
  companies: [
    { id: "workspace-a", name: "Workspace A", issuePrefix: "SPS" },
    { id: "workspace-b", name: "Workspace B", issuePrefix: "OTHER" },
  ],
  selectedCompanyId: "workspace-b" as string | null,
  selectionSource: "bootstrap" as "bootstrap" | "manual" | "route_sync",
  loading: false,
  error: null as Error | null,
}));

vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ ...companyState, setSelectedCompanyId: mocks.select, reloadCompanies: mocks.reload }),
}));
vi.mock("@/api/workspace-surfaces", () => ({ workspaceSurfacesApi: { getShell: mocks.shell } }));
vi.mock("@/api/plugins", () => ({ pluginsApi: { listUiContributions: mocks.contributions } }));
vi.mock("./Layout", () => ({ Layout: () => { mocks.legacy(); return <div data-legacy-layout="true"><Outlet /></div>; } }));
vi.mock("@/pages/NotFound", () => ({ NotFoundPage: () => <div>Workspace not found</div> }));

import { SpsWorkspaceLayout } from "./SpsWorkspaceLayout";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const neutral: SpsWorkspaceShellState = { mode: "neutral", providerPluginId: null, providerPluginKey: null, shell: null, fallbackReason: null };
const selected: SpsWorkspaceShellState = { mode: "plugin", providerPluginId: "plugin-a", providerPluginKey: "workflow-a", shell: { id: "workflow", displayName: "Workflow", defaultRoute: "/builder" }, fallbackReason: null };
let navigate: ReturnType<typeof useNavigate>;

function RouteProbe() {
  navigate = useNavigate();
  const location = useLocation();
  return <div data-current-route={location.pathname} data-current-location={`${location.pathname}${location.search}${location.hash}`} />;
}

function pageContribution(pluginId: string, routePath: string) {
  return {
    pluginId,
    pluginKey: pluginId,
    displayName: pluginId,
    version: "1.0.0",
    uiEntryFile: "index.js",
    slots: [{ type: "page" as const, id: `${pluginId}-page`, displayName: pluginId, exportName: "Page", routePath }],
    launchers: [],
    workspaceShell: null,
    dashboardWidgets: [],
  };
}

describe("SpsWorkspaceLayout", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    document.head.innerHTML = '<meta name="sps-basic-mode" content="true"><meta name="sps-core-baseline-mode" content="true">';
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    companyState.selectedCompanyId = "workspace-b";
    companyState.selectionSource = "bootstrap";
    companyState.loading = false;
    companyState.error = null;
    vi.clearAllMocks();
    mocks.shell.mockResolvedValue(neutral);
    mocks.contributions.mockResolvedValue([]);
    mocks.reload.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    document.head.innerHTML = "";
  });

  async function settle() {
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  async function render(route = "/SPS") {
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <RouteProbe />
          <Routes>
            <Route path=":companyPrefix" element={<SpsWorkspaceLayout />}>
              <Route index element={<p>Compatibility index</p>} />
              <Route path="plugins/:pluginId" element={<p data-testid="plugin-id-page">Plugin id page</p>} />
              <Route path="company/settings/*" element={<p data-testid="settings-route">Core settings route</p>} />
              <Route path="execution-workspaces/*" element={<p data-testid="execution-workspaces-route">Execution Workspaces route</p>} />
              <Route path="projects/*" element={<p data-testid="projects-route">Projects route</p>} />
              <Route path="agents/*" element={<p data-testid="agents-route">Agents route</p>} />
              <Route path="assistants/*" element={<p data-testid="assistants-route">Assistants route</p>} />
              <Route path="agent-rooms/*" element={<p data-testid="agent-rooms-route">Legacy rooms route</p>} />
              <Route path="tasks/*" element={<p data-testid="tasks-route">Legacy tasks route</p>} />
              <Route path="organization/*" element={<p data-testid="organization-route">Legacy organization route</p>} />
              <Route path=":pluginRoutePath" element={<p data-testid="plugin-alias-page">Plugin alias page</p>} />
              <Route path=":pluginRoutePath/*" element={<p data-testid="plugin-alias-page">Plugin nested page</p>} />
              <Route path="*" element={<p>Compatibility page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ));
    await settle();
  }

  it("uses the route Workspace, not the previously selected Workspace, without mounting the common Shell", async () => {
    await render();
    expect(mocks.shell).toHaveBeenCalledWith("workspace-a");
    expect(mocks.shell).not.toHaveBeenCalledWith("workspace-b");
    expect(container.querySelector('[data-sps-workspace-entry="empty"]')).not.toBeNull();
    expect(container.querySelector('a[href="/SPS/company/settings/instance/plugins"]')).not.toBeNull();
    expect(container.textContent).toContain("Workspace A");
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledWith("workspace-a", { source: "route_sync" });
  });

  it("preserves an in-progress manual Workspace switch", async () => {
    companyState.selectionSource = "manual";
    await render();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.shell).toHaveBeenCalledWith("workspace-a");
  });

  it("does not query a Workspace or register an Agent while the list loads", async () => {
    companyState.loading = true;
    await render();
    expect(container.textContent).toContain("Loading workspace");
    expect(mocks.shell).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("treats a Workspace-list error separately from an empty Workspace", async () => {
    companyState.error = new Error("private diagnostic");
    await render();
    expect(container.querySelector('[data-sps-workspace-entry="unavailable"]')).not.toBeNull();
    expect(container.textContent).not.toContain("private diagnostic");
    expect(container.querySelector("a")).toBeNull();
    act(() => container.querySelector("button")?.click());
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(mocks.shell).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("does not fall back to another Workspace for an unknown prefix", async () => {
    await render("/UNKNOWN");
    expect(container.textContent).toContain("Workspace not found");
    expect(mocks.shell).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("does not resolve a deep plugin route for an invalid Workspace prefix", async () => {
    await render("/UNKNOWN/discover");
    expect(mocks.contributions).not.toHaveBeenCalled();
    expect(mocks.legacy).toHaveBeenCalled();
  });

  it("canonicalizes prefix case before opening a plugin route", async () => {
    mocks.shell.mockResolvedValue(selected);
    await render("/sps");
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/SPS/builder");
  });

  it("renders the selected Primary page without the compatibility layout", async () => {
    mocks.shell.mockResolvedValue(selected);
    mocks.contributions.mockResolvedValue([pageContribution("plugin-a", "builder")]);
    await render();
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/SPS/builder");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.contributions).toHaveBeenCalledWith("workspace-a");
    expect(container.querySelector('[data-sps-plugin-surface="true"]')?.className).toContain("h-dvh");
  });

  it("renders an enabled Extension page route full-screen and syncs its Workspace", async () => {
    mocks.contributions.mockResolvedValue([pageContribution("extension-plugin", "wiki")]);
    await render("/SPS/wiki/nested/page?view=full#section");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')?.textContent).toBe("Plugin nested page");
    expect(container.querySelector("[data-current-location]")?.getAttribute("data-current-location")).toBe("/SPS/wiki/nested/page?view=full#section");
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledWith("workspace-a", { source: "route_sync" });
  });

  it("renders the direct plugin-id page route full-screen", async () => {
    mocks.contributions.mockResolvedValue([pageContribution("plugin-a", "unused-alias")]);
    await render("/SPS/plugins/plugin-a");
    expect(container.querySelector('[data-testid="plugin-id-page"]')).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it.each(["dashboard", "inbox", "assistants/new", "company/settings/instance/plugins"])(
    "keeps explicit Core route %s in the compatibility layout",
    async (route) => {
      mocks.contributions.mockResolvedValue([pageContribution("extension-plugin", route.split("/")[0]!)]);
      await render(`/SPS/${route}`);
      expect(mocks.legacy).toHaveBeenCalled();
      expect(mocks.contributions).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["tasks", "tasks-route"],
    ["agent-rooms", "agent-rooms-route"],
    ["organization", "organization-route"],
    ["project/project-a", "plugin-alias-page"],
    ["projects/project-a", "projects-route"],
    ["execution-workspaces/workspace-a", "execution-workspaces-route"],
    ["agents", "agents-route"],
  ])("renders declared Plugin alias %s without the compatibility layout", async (route, testId) => {
    mocks.contributions.mockResolvedValue([pageContribution("extension-plugin", route.split("/")[0]!)]);
    await render(`/SPS/${route}`);
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.contributions).toHaveBeenCalledWith("workspace-a");
  });

  it("canonicalizes the company prefix without replacing a plugin deep link, query, or hash", async () => {
    mocks.contributions.mockResolvedValue([pageContribution("extension-plugin", "discover")]);
    await render("/sps/discover/templates?tab=one#selected");
    expect(container.querySelector("[data-current-location]")?.getAttribute("data-current-location"))
      .toBe("/SPS/discover/templates?tab=one#selected");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("shows a generic retry state when Plugin page lookup fails, then resolves the declared page", async () => {
    let resolveRetry!: (contributions: ReturnType<typeof pageContribution>[]) => void;
    mocks.contributions.mockRejectedValueOnce(new Error("private diagnostic"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    await render("/SPS/discover");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Plugin page could not be loaded.");
    expect(container.textContent).not.toContain("private diagnostic");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    act(() => retry!.click());
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading workspace");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
    await act(async () => resolveRetry([pageContribution("extension-plugin", "discover")]));
    await settle();
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("does not render cached Plugin content or CompatibilityLayout while revalidating, including after failure", async () => {
    client.setQueryData(queryKeys.plugins.uiContributions("workspace-a"), [pageContribution("extension-plugin", "discover")]);
    let reject!: (reason: Error) => void;
    mocks.contributions.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await render("/SPS/discover");

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading workspace");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();

    await act(async () => reject(new Error("private stale-cache diagnostic")));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Plugin page could not be loaded.");
    expect(container.querySelector('[data-testid="plugin-alias-page"]')).toBeNull();
    expect(container.textContent).not.toContain("private stale-cache diagnostic");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("keeps root-valued old manifests out of a redirect loop", async () => {
    mocks.shell.mockResolvedValue({ ...selected, shell: { ...selected.shell, defaultRoute: "/" } });
    await render();
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/SPS/dashboard");
  });

  it("shows an unavailable selection without displaying private fallback diagnostics", async () => {
    mocks.shell.mockResolvedValue({ ...neutral, fallbackReason: "private plugin path" });
    await render();
    expect(container.textContent).toContain("The selected plugin is unavailable.");
    expect(container.textContent).not.toContain("private plugin path");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("never redirects using cached selection while its validation is pending or failed", async () => {
    client.setQueryData(queryKeys.workspaceSurfaces.shell("workspace-a"), selected);
    let reject!: (reason: Error) => void;
    mocks.shell.mockImplementation(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    await render();
    expect(container.textContent).toContain("Loading workspace");
    expect(mocks.legacy).not.toHaveBeenCalled();
    await act(async () => reject(new Error("private request diagnostic")));
    await settle();
    expect(container.querySelector('[data-sps-workspace-entry="unavailable"]')).not.toBeNull();
    expect(container.textContent).not.toContain("private request diagnostic");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("retries a failed selection only after an explicit click", async () => {
    mocks.shell.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(neutral);
    await render();
    expect(mocks.shell).toHaveBeenCalledTimes(1);
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    act(() => retry!.click());
    await settle();
    expect(mocks.shell).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-sps-workspace-entry="empty"]')).not.toBeNull();
  });

  it.each([null, { ...selected, shell: null }, { ...neutral, mode: "unknown" }])("does not present a malformed selection response as an empty Workspace", async (selection) => {
    mocks.shell.mockResolvedValue(selection);
    await render();
    expect(container.querySelector('[data-sps-workspace-entry="unavailable"]')).not.toBeNull();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("changes selection scope with the route without carrying another Workspace's shell", async () => {
    mocks.shell.mockImplementation(async (id: string) => id === "workspace-a" ? neutral : selected);
    await render();
    act(() => navigate("/OTHER"));
    await settle();
    expect(mocks.shell).toHaveBeenCalledWith("workspace-b");
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/OTHER/builder");
  });

  it.each(["dashboard", "inbox", "assistants/new", "company/settings/instance/plugins", "builder"])("preserves the explicit compatibility route %s", async (route) => {
    await render(`/SPS/${route}`);
    expect(mocks.shell).not.toHaveBeenCalled();
    expect(mocks.legacy).toHaveBeenCalled();
  });

  it.each(["sps-basic-mode", "sps-core-baseline-mode"])("does not change the legacy root when %s is off", async (flag) => {
    document.querySelector(`meta[name="${flag}"]`)?.setAttribute("content", "false");
    await render();
    expect(mocks.legacy).toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });

  it("preserves Workplane-mode startup", async () => {
    const flag = document.createElement("meta");
    flag.name = "sps-workplane-mode";
    flag.content = "true";
    document.head.append(flag);
    await render();
    expect(mocks.legacy).toHaveBeenCalled();
    expect(mocks.shell).not.toHaveBeenCalled();
  });
});
