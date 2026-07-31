// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  getShell: vi.fn(),
  getDashboard: vi.fn(),
  saveDashboardLayout: vi.fn(),
  listUiContributions: vi.fn(),
  ensureContributionLoaded: vi.fn(),
}));
const breadcrumbMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: { listUiContributions: apiMocks.listUiContributions },
}));
vi.mock("@/api/workspace-surfaces", () => ({
  workspaceSurfacesApi: {
    getShell: apiMocks.getShell,
    getDashboard: apiMocks.getDashboard,
    saveDashboardLayout: apiMocks.saveDashboardLayout,
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "workspace-1", name: "Prototype Workspace", issuePrefix: "SPS" },
    selectedCompanyId: "workspace-1",
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbMock }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <span data-redirect={to} />,
}));
vi.mock("@/plugins/slots", () => ({
  ensurePluginContributionLoaded: apiMocks.ensureContributionLoaded,
  PluginDashboardWidgetMount: ({ pluginDisplayName, widget }: { pluginDisplayName: string; widget: { displayName: string } }) => (
    <div data-testid={`widget-${widget.displayName}`}>{pluginDisplayName} widget</div>
  ),
}));

import { SpsCoreWorkspaceHome } from "./SpsCoreWorkspaceHome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function assistant() {
  return { id: "assistant-1", name: "Workspace Assistant", title: "Lead", status: "idle", adapterType: "codex_local" };
}

function neutralShell(overrides: Record<string, unknown> = {}) {
  return { mode: "neutral", providerPluginId: null, providerPluginKey: null, shell: null, fallbackReason: null, ...overrides };
}

function widget(id: string, displayName: string, position: number) {
  return {
    pluginId: "plugin-1",
    pluginKey: "workflow-kit",
    pluginDisplayName: "Workflow Kit",
    widget: { id, displayName, description: `${displayName} description`, exportName: "Widget", sizes: ["small", "medium", "large", "full"] },
    layout: { size: "medium", position, collapsed: false, source: "default" },
  };
}

describe("SpsCoreWorkspaceHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    apiMocks.agentsList.mockResolvedValue([assistant()]);
    apiMocks.getShell.mockResolvedValue(neutralShell());
    apiMocks.getDashboard.mockResolvedValue({ widgets: [] });
    apiMocks.listUiContributions.mockResolvedValue([]);
    apiMocks.saveDashboardLayout.mockResolvedValue({ widgets: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(<QueryClientProvider client={queryClient}><SpsCoreWorkspaceHome /></QueryClientProvider>);
    });
  }

  it("shows the neutral Dashboard empty state when no plugin contributes widgets", async () => {
    render();
    await settle();
    await settle();

    expect(container.textContent).toContain("Neutral Workspace shows Core status");
    expect(container.textContent).toContain("No Dashboard widgets yet");
    expect(container.innerHTML).toContain('href="/company/settings/instance/plugins"');
    expect(breadcrumbMock).toHaveBeenCalledWith([{ label: "Prototype Workspace" }]);
  });

  it("warns when a selected Shell falls back to Neutral Core", async () => {
    apiMocks.getShell.mockResolvedValue(neutralShell({
      fallbackReason: "The selected shell is no longer active.",
    }));
    render();
    await settle();
    await settle();

    expect(container.textContent).toContain("Neutral Shell restored");
    expect(container.textContent).toContain("The selected shell is no longer active.");
    expect(container.innerHTML).toContain('href="/company/settings/workspace-appearance"');
  });

  it("mounts plugin widgets and persists an explicit layout change", async () => {
    const widgets = [widget("first", "First widget", 0), widget("second", "Second widget", 1)];
    apiMocks.getDashboard.mockResolvedValue({ widgets });
    apiMocks.listUiContributions.mockResolvedValue([{
      pluginId: "plugin-1", pluginKey: "workflow-kit", displayName: "Workflow Kit", version: "1.0.0",
      uiEntryFile: "index.js", slots: [], launchers: [], workspaceShell: null, dashboardWidgets: [],
    }]);
    apiMocks.saveDashboardLayout.mockResolvedValue({ widgets });
    render();
    await settle();
    await settle();
    await settle();

    expect(container.querySelector('[data-testid="widget-First widget"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="widget-Second widget"]')).not.toBeNull();
    expect(apiMocks.ensureContributionLoaded).toHaveBeenCalled();

    const moveDown = container.querySelector<HTMLButtonElement>('button[aria-label="Move First widget down"]');
    expect(moveDown).not.toBeNull();
    act(() => moveDown?.click());
    await settle();

    expect(apiMocks.saveDashboardLayout).toHaveBeenCalledWith("workspace-1", [
      expect.objectContaining({ widgetId: "second", position: 0 }),
      expect.objectContaining({ widgetId: "first", position: 1 }),
    ]);
  });
});
