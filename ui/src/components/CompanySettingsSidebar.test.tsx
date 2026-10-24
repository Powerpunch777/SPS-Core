// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettingsSidebar } from "./CompanySettingsSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const mockSidebarBadgesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockPluginsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockUsePluginSlots = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: () => void;
  }) => (
    <button type="button" data-to={to} onClick={onClick}>
      {children}
    </button>
  ),
  NavLink: ({
    children,
    to,
  }: {
    children: React.ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: {
    to: string;
    label: string;
    end?: boolean;
    badge?: number;
  }) => {
    sidebarNavItemMock(props);
    return <div>{props.label}</div>;
  },
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Workspace switcher</div>,
}));

vi.mock("@/api/sidebarBadges", () => ({
  sidebarBadgesApi: mockSidebarBadgesApi,
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("CompanySettingsSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSidebarBadgesApi.get.mockResolvedValue({
      inbox: 0,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 2,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: false,
    });
    mockPluginsApi.list.mockResolvedValue([]);
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    document.head.querySelector('meta[name="sps-basic-mode"]')?.remove();
    document.head.querySelector('meta[name="sps-workplane-mode"]')?.remove();
    document.head.querySelector('meta[name="sps-core-baseline-mode"]')?.remove();
    vi.clearAllMocks();
  });

  it("renders the company back link and the settings sections in the sidebar", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Company Settings");
    expect(container.textContent).toContain("Company settings");
    expect(container.textContent).toContain("Instance settings");
    expect(container.textContent).toContain("General");
    expect(container.textContent).toContain("Environments");
    expect(container.textContent).not.toContain("Cloud upstream");
    expect(container.textContent).toContain("Members");
    expect(container.textContent).not.toContain("Cloud upstream");
    expect(container.textContent).toContain("Invites");
    expect(container.textContent).toContain("Nodes");
    expect(container.textContent).toContain("Project Sources");
    expect(container.textContent).toContain("Secrets");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings",
        label: "General",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/environments",
        label: "Environments",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/members",
        label: "Members",
        badge: 2,
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/invites",
        label: "Invites",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/nodes",
        label: "Nodes",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/project-sources",
        label: "Project Sources",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/secrets",
        label: "Secrets",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/profile",
        label: "Profile",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/general",
        label: "General",
        end: true,
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/plugins",
        label: "Plugins",
      }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/instance/adapters",
        label: "Adapters",
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("uses concise SPS labels in the workplane shell", async () => {
    const basicMode = document.createElement("meta");
    basicMode.name = "sps-basic-mode";
    basicMode.content = "true";
    document.head.appendChild(basicMode);
    const workplaneMode = document.createElement("meta");
    workplaneMode.name = "sps-workplane-mode";
    workplaneMode.content = "true";
    document.head.appendChild(workplaneMode);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("서버 설정");
    expect(container.textContent).toContain("워크스페이스");
    expect(container.textContent).toContain("컴퓨터와 노드");
    expect(container.textContent).toContain("Agent 연결");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/company/settings/nodes", label: "컴퓨터와 노드" }),
    );

    await act(async () => {
      root.unmount();
    });
    basicMode.remove();
    workplaneMode.remove();
  });

  it("shows only technical Workspace settings in the plugin-first Core baseline", async () => {
    const basicMode = document.createElement("meta");
    basicMode.name = "sps-basic-mode";
    basicMode.content = "true";
    document.head.appendChild(basicMode);
    const baselineMode = document.createElement("meta");
    baselineMode.name = "sps-core-baseline-mode";
    baselineMode.content = "true";
    document.head.appendChild(baselineMode);
    mockPluginsApi.list.mockResolvedValue([{
      id: "builder",
      packageName: "sps.plugin-discovery",
      manifestJson: { displayName: "Plugin Builder", environmentDrivers: [] },
    }]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Host settings");
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Sources");
    expect(container.textContent).toContain("Nodes");
    expect(container.textContent).toContain("Plugins");
    expect(container.textContent).toContain("Installed packages");
    expect(container.textContent).toContain("Plugin Builder");
    expect(container.textContent).not.toContain("Workspace appearance");
    expect(container.textContent).not.toContain("Members");
    expect(container.textContent).not.toContain("Invites");
    expect(container.textContent).not.toContain("Secrets");
    expect(container.textContent).not.toContain("Experimental");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/company/settings/project-sources", label: "Sources", end: true }),
    );
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/company/settings/agents", label: "Agents", end: true }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows cloud upstream only when cloud sync is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: true,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Cloud upstream");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/cloud-upstream",
        label: "Cloud upstream",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders company settings pages contributed by ready plugins", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          exportName: "PermissionsPage",
          routePath: "permissions",
          pluginId: "plugin-1",
          pluginKey: "permissions-extension",
          pluginDisplayName: "Permissions Extension",
          pluginVersion: "0.1.0",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Permissions");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/permissions",
        label: "Permissions",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows cloud upstream only when cloud sync is enabled", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableCloudSync: true,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Cloud upstream");
    expect(sidebarNavItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/company/settings/cloud-upstream",
        label: "Cloud upstream",
        end: true,
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("renders instance plugin links while filtering sandbox-provider-only plugins", async () => {
    mockPluginsApi.list.mockResolvedValue([
      {
        id: "linear",
        packageName: "@example/linear",
        manifestJson: {
          displayName: "Linear",
          environmentDrivers: [],
        },
      },
      {
        id: "sandbox-only",
        packageName: "@example/sandbox",
        manifestJson: {
          displayName: "Sandbox only",
          environmentDrivers: [{ kind: "sandbox_provider", driverKey: "e2b" }],
        },
      },
      {
        id: "hybrid",
        packageName: "@example/hybrid",
        manifestJson: {
          displayName: "Hybrid",
          environmentDrivers: [
            { kind: "sandbox_provider", driverKey: "e2b" },
            { kind: "environment_driver", driverKey: "ssh" },
          ],
        },
      },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySettingsSidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const pluginLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href^="/company/settings/instance/plugins/"]'),
    );
    expect(pluginLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/company/settings/instance/plugins/linear",
      "/company/settings/instance/plugins/hybrid",
    ]);
    expect(container.textContent).toContain("Linear");
    expect(container.textContent).toContain("Hybrid");
    expect(container.textContent).not.toContain("Sandbox only");

    await act(async () => {
      root.unmount();
    });
  });
});
