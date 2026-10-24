// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  breadcrumbs: vi.fn(),
  companyId: "workspace-1" as string | null,
}));

vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.list } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: mocks.companyId,
    selectedCompany: mocks.companyId ? { id: mocks.companyId, name: "Test Workspace" } : null,
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

import { SpsCoreAgents } from "./SpsCoreAgents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function agent(id: string, name: string, status = "idle", adapterType = "codex_local") {
  return {
    id, name, status, adapterType,
    title: "Private workflow role",
    adapterConfig: { cwd: "C:/private/project", env: { TOKEN: "private-token" } },
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsCoreAgents", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.companyId = "workspace-1";
    mocks.list.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  async function render() {
    act(() => {
      root.render(<QueryClientProvider client={queryClient}><SpsCoreAgents /></QueryClientProvider>);
    });
    await settle();
    await settle();
  }

  it("lists nonterminated Agents with status, adapter, and existing create/detail links", async () => {
    const agents = [
      agent("codex-1", "Coding Agent"),
      agent("claude-2", "Review Agent", "paused", "claude_local"),
      agent("old-3", "Retired Agent", "terminated"),
    ];
    mocks.list.mockResolvedValue(agents);
    await render();

    expect(mocks.list).toHaveBeenCalledWith("workspace-1");
    expect(queryClient.getQueryData(queryKeys.agents.list("workspace-1"))).toEqual(agents);
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(container.querySelector('a[href="/assistants/new"]')?.textContent).toContain("Add Agent");
    expect(container.querySelector('a[href="/assistants/codex-1"]')?.textContent).toBe("Coding Agent");
    expect(container.querySelector('a[href="/assistants/claude-2"]')?.textContent).toBe("Review Agent");
    expect(container.querySelectorAll('ul[aria-label="Agents"] > li')).toHaveLength(2);
    expect(container.textContent).toContain("idle");
    expect(container.textContent).toContain("paused");
    expect(container.textContent).toContain("Adapter: codex_local");
    expect(container.textContent).toContain("Adapter: claude_local");
    expect(container.textContent).not.toContain("Retired Agent");
    expect(container.textContent).not.toContain("Private workflow role");
    expect(container.textContent).not.toContain("C:/private/project");
    expect(container.textContent).not.toContain("private-token");
    expect(mocks.breadcrumbs).toHaveBeenCalledWith([
      { label: "Test Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Agents" },
    ]);
  });

  it("shows loading without prematurely showing the empty state", async () => {
    let resolveList!: (agents: ReturnType<typeof agent>[]) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    await render();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading Agents...");
    expect(container.textContent).not.toContain("No Agents yet");
    expect(container.querySelector('a[href="/assistants/new"]')).not.toBeNull();

    await act(async () => { resolveList([agent("ready", "Ready Agent")]); });
    await settle();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('a[href="/assistants/ready"]')).not.toBeNull();
  });

  it.each([
    { label: "empty response", agents: [] },
    { label: "terminated Agents only", agents: [agent("old", "Retired Agent", "terminated")] },
  ])("keeps creation available for an empty directory: $label", async ({ agents }) => {
    mocks.list.mockResolvedValue(agents);
    await render();

    expect(container.textContent).toContain("No Agents yet");
    expect(container.querySelector('a[href="/assistants/new"]')?.textContent).toContain("Add Agent");
    expect(container.querySelector('ul[aria-label="Agents"]')).toBeNull();
  });

  it("offers an explicit retry after a failed read and recovers the directory", async () => {
    mocks.list.mockRejectedValueOnce(new Error("private backend detail"));
    mocks.list.mockResolvedValueOnce([agent("recovered", "Recovered Agent")]);
    await render();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Agents could not be loaded");
    expect(container.textContent).not.toContain("private backend detail");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await settle();
    await settle();

    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('a[href="/assistants/recovered"]')).not.toBeNull();
  });

  it("does not read Agents until a Workspace is selected", async () => {
    mocks.companyId = null;
    await render();

    expect(mocks.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a Workspace");
    expect(container.querySelector('a[href="/assistants/new"]')).toBeNull();
  });
});
