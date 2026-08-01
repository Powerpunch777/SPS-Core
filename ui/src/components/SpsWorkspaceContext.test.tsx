// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsWorkspaceContext } from "./SpsWorkspaceContext";

const mockPluginsApi = vi.hoisted(() => ({ listForCompany: vi.fn() }));
const mockLocation = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "workspace-1",
    selectedCompany: { id: "workspace-1", name: "Atlas", issuePrefix: "ATL" },
  }),
}));
vi.mock("@/lib/router", () => ({ useLocation: () => mockLocation }));

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SpsWorkspaceContext", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mockLocation.pathname = "/dashboard";
    mockPluginsApi.listForCompany.mockResolvedValue({
      companyId: "workspace-1",
      plugins: [
        {
          id: "plugin-1",
          pluginKey: "sps.builder",
          displayName: "Plugin Discovery & Builder",
          version: "1.2.3",
          status: "ready",
          activation: { enabled: true },
        },
      ],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders live Workspace and plugin data instead of prototype fixtures", async () => {
    await act(async () => {
      root.render(<Providers><SpsWorkspaceContext /></Providers>);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("Dashboard");
    expect(container.textContent).toContain("Core");
    expect(container.textContent).toContain("Plugin Discovery & Builder");
    expect(container.textContent).toContain("1 of 1 ready");
    expect(mockPluginsApi.listForCompany).toHaveBeenCalledWith("workspace-1");
  });

  it("marks non-Core routes as plugin-owned", async () => {
    mockLocation.pathname = "/ATL/agent-rooms";
    await act(async () => {
      root.render(<Providers><SpsWorkspaceContext /></Providers>);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("agent rooms");
    expect(container.textContent).toContain("Plugin-owned");
  });
});
