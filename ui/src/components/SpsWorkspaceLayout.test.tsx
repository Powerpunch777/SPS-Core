// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpsWorkspaceShellState } from "@/api/workspace-surfaces";

const mocks = vi.hoisted(() => ({ shell: vi.fn(), legacy: vi.fn(), select: vi.fn(), reload: vi.fn() }));
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
  return <div data-current-route={useLocation().pathname} />;
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

  it("canonicalizes prefix case before opening a plugin route", async () => {
    mocks.shell.mockResolvedValue(selected);
    await render("/sps");
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/SPS/builder");
  });

  it("retains the selected plugin route and legacy layout for existing manifests", async () => {
    mocks.shell.mockResolvedValue(selected);
    await render();
    expect(container.querySelector("[data-current-route]")?.getAttribute("data-current-route")).toBe("/SPS/builder");
    expect(mocks.legacy).toHaveBeenCalled();
    expect(container.textContent).toContain("Compatibility page");
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
