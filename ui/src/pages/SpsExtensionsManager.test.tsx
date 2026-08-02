// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsExtensionsManager } from "./SpsExtensionsManager";

const listPlugins = vi.hoisted(() => vi.fn());
const listForCompany = vi.hoisted(() => vi.fn());
const enablePlugin = vi.hoisted(() => vi.fn());
const setCompanyActivation = vi.hoisted(() => vi.fn());
const uninstallPlugin = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: () => listPlugins(),
    listForCompany: (companyId: string) => listForCompany(companyId),
    enable: (pluginId: string) => enablePlugin(pluginId),
    setCompanyActivation: (pluginId: string, companyId: string, enabled: boolean) => setCompanyActivation(pluginId, companyId, enabled),
    uninstall: (pluginId: string, options: { deleteInboxSummaries?: boolean }) => uninstallPlugin(pluginId, options),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "workspace-1", name: "SPS Test", issuePrefix: "SPS" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));
vi.mock("@/components/SpsMarketplacePanel", () => ({
  SpsMarketplacePanel: ({ companyId }: { companyId: string }) => <div>Marketplace for {companyId}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsExtensionsManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listPlugins.mockResolvedValue([{
      id: "workplane-plugin",
      packageName: "local.room-chat",
      status: "error",
      version: "1.0.0",
      manifestJson: { id: "local.room-chat", displayName: "SPS Team Workplane", description: "Rooms and Tasks", version: "1.0.0" },
    }]);
    listForCompany.mockResolvedValue({
      companyId: "workspace-1",
      plugins: [{ id: "workplane-plugin", activation: { enabled: false } }],
    });
    enablePlugin.mockResolvedValue({ ok: true });
    setCompanyActivation.mockResolvedValue({ activation: { enabled: true } });
    uninstallPlugin.mockResolvedValue({ ok: true });
    delete (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    delete (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace;
  });

  it("starts a paused package and enables it for the current Workspace with one action", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsExtensionsManager /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('[data-sps-surface-owner="core"]')).not.toBeNull();
    expect(container.textContent).toContain("Installed plugins remain plugin-owned surfaces");
    const action = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Start and use"));
    expect(action).toBeTruthy();
    await act(async () => { action?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    expect(enablePlugin).toHaveBeenCalledWith("workplane-plugin");
    expect(setCompanyActivation).toHaveBeenCalledWith("workplane-plugin", "workspace-1", true);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension ready in this Workspace", tone: "success" }));

    await act(async () => { root.unmount(); });
  });

  it("keeps Inbox summaries by default and only deletes them after the Host checks the option", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsExtensionsManager /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();
    await flushReact();

    const uninstall = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Uninstall"));
    await act(async () => { uninstall?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    const keep = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Uninstall and keep summaries");
    await act(async () => { keep?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(uninstallPlugin).toHaveBeenCalledWith("workplane-plugin", { deleteInboxSummaries: false });

    await act(async () => { uninstall?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    const checkbox = document.body.querySelector('[aria-label="Delete Inbox summaries"]');
    await act(async () => { checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const deleteSummaries = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Uninstall and delete summaries");
    await act(async () => { deleteSummaries?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(uninstallPlugin).toHaveBeenLastCalledWith("workplane-plugin", { deleteInboxSummaries: true });

    await act(async () => { root.unmount(); });
  });

  it("opens Marketplace inside Settings and delegates installation to the Host review window", async () => {
    const openPluginRegistries = vi.fn().mockResolvedValue({ opened: true });
    (window as Window & { spsDesktopWorkspace?: unknown }).spsDesktopWorkspace = { openPluginRegistries };
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsExtensionsManager /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();
    await flushReact();

    const marketplace = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Marketplace");
    await act(async () => { marketplace?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(container.textContent).toContain("Marketplace for workspace-1");

    const review = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Open secure install review");
    await act(async () => { review?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(openPluginRegistries).toHaveBeenCalledOnce();

    await act(async () => { root.unmount(); });
  });
});
