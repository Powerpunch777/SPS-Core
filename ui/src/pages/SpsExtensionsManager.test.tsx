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
const setBreadcrumbs = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: {
    list: () => listPlugins(),
    listForCompany: (companyId: string) => listForCompany(companyId),
    enable: (pluginId: string) => enablePlugin(pluginId),
    setCompanyActivation: (pluginId: string, companyId: string, enabled: boolean) => setCompanyActivation(pluginId, companyId, enabled),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "workspace-1", name: "SPS Test", issuePrefix: "SPS" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

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
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("starts a paused package and enables it for the current Workspace with one action", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsExtensionsManager /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();
    await flushReact();

    const action = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Start and use"));
    expect(action).toBeTruthy();
    await act(async () => { action?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    expect(enablePlugin).toHaveBeenCalledWith("workplane-plugin");
    expect(setCompanyActivation).toHaveBeenCalledWith("workplane-plugin", "workspace-1", true);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Extension ready in this Workspace", tone: "success" }));

    await act(async () => { root.unmount(); });
  });
});
