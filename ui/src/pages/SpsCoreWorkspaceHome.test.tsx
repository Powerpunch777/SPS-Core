// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreWorkspaceHome } from "./SpsCoreWorkspaceHome";
import { queryKeys } from "@/lib/queryKeys";
const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "workspace-1", name: "Prototype Workspace" },
    selectedCompanyId: "workspace-1",
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    mockNavigate({ to, replace });
    return <span data-redirect={to} />;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("SpsCoreWorkspaceHome", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the Workspace home neutral and directs plugin management to settings", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "assistant-1", name: "Workspace Assistant", title: "Initial Assistant", status: "idle", adapterType: "codex_local" },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <SpsCoreWorkspaceHome />
      </QueryClientProvider>,
    );
    await flushReact();
    await flushReact();
    await flushReact();
    await flushReact();

    expect(mockAgentsApi.list).toHaveBeenCalledWith("workspace-1");
    expect(container.textContent).toContain("Workspace Assistant");
    expect(container.innerHTML).toContain('href="/company/settings/instance/plugins"');
    expect(container.innerHTML).toContain('href="/assistants/assistant-1"');
    expect(container.textContent).not.toContain("Enabled plugins");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Prototype Workspace" }]);

    root.unmount();
  });

  it("requires an initial Assistant before opening the Workspace", async () => {
    mockAgentsApi.list.mockResolvedValue([]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <SpsCoreWorkspaceHome />
      </QueryClientProvider>,
    );
    await flushReact();
    await flushReact();
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith({ to: "/assistants/new", replace: true });
    expect(container.innerHTML).toContain('data-redirect="/assistants/new"');

    root.unmount();
  });

  it("does not redirect while a newly created Assistant replaces cached empty data", async () => {
    let resolveAgents!: (agents: Array<{ id: string; name: string; title: string; status: string; adapterType: string }>) => void;
    mockAgentsApi.list.mockReturnValue(new Promise((resolve) => {
      resolveAgents = resolve;
    }));
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.agents.list("workspace-1"), []);

    root.render(
      <QueryClientProvider client={queryClient}>
        <SpsCoreWorkspaceHome />
      </QueryClientProvider>,
    );
    await flushReact();
    await flushReact();

    expect(mockNavigate).not.toHaveBeenCalled();

    resolveAgents([
      { id: "assistant-1", name: "Workspace Assistant", title: "Initial Assistant", status: "idle", adapterType: "codex_local" },
    ]);
    await flushReact();
    await flushReact();

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Workspace Assistant");

    root.unmount();
  });
});
