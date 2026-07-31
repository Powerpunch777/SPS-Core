// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreWorkspaceAppearance } from "./SpsCoreWorkspaceAppearance";

const getShellMock = vi.hoisted(() => vi.fn());
const listShellProvidersMock = vi.hoisted(() => vi.fn());
const selectShellMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/workspace-surfaces", () => ({
  workspaceSurfacesApi: {
    getShell: (companyId: string) => getShellMock(companyId),
    listShellProviders: (companyId: string) => listShellProvidersMock(companyId),
    selectShell: (companyId: string, input: unknown) => selectShellMock(companyId, input),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "workspace-1", selectedCompany: { id: "workspace-1", name: "Prototype Workspace" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsCoreWorkspaceAppearance", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getShellMock.mockResolvedValue({
      mode: "neutral",
      providerPluginId: null,
      providerPluginKey: null,
      shell: null,
      fallbackReason: "The previously selected shell is no longer active.",
    });
    listShellProvidersMock.mockResolvedValue([{
      pluginId: "plugin-1",
      pluginKey: "team-workplane",
      pluginDisplayName: "Team Workplane",
      shell: { id: "workplane", displayName: "Team Workplane Shell", defaultRoute: "/team" },
    }]);
    selectShellMock.mockResolvedValue({ mode: "plugin", providerPluginId: "plugin-1", providerPluginKey: "team-workplane", shell: { id: "workplane", displayName: "Team Workplane Shell" }, fallbackReason: null });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps Neutral Core Shell until a Host explicitly chooses and applies a provider", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><SpsCoreWorkspaceAppearance /></QueryClientProvider></MemoryRouter>);
    });
    await flushReact();

    expect(container.textContent).toContain("SPS restored the Neutral Core Shell");
    expect(container.textContent).toContain("Team Workplane Shell");
    expect(selectShellMock).not.toHaveBeenCalled();

    const provider = Array.from(container.querySelectorAll('button[role="radio"]')).find((button) => button.textContent?.includes("Team Workplane Shell"));
    await act(async () => { provider?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const apply = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Apply Workspace Shell"));
    await act(async () => { apply?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    expect(selectShellMock).toHaveBeenCalledWith("workspace-1", { pluginId: "plugin-1", shellId: "workplane" });
    await act(async () => { root.unmount(); });
  });
});
