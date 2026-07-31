// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettings } from "./PluginSettings";

const mockPluginsApi = vi.hoisted(() => ({
  get: vi.fn(),
  diagnostics: vi.fn(),
  health: vi.fn(),
  dashboard: vi.fn(),
  logs: vi.fn(),
  migrationPlan: vi.fn(),
  pendingUpdate: vi.fn(),
  upgrade: vi.fn(),
  getConfig: vi.fn(),
  listLocalFolders: vi.fn(),
  configureLocalFolder: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => ({ companyPrefix: "PAP", pluginId: "plugin-1" }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({ items, onValueChange }: {
    items: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} type="button" onClick={() => onValueChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function basePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-1",
    pluginKey: "paperclip.e2b-sandbox-provider",
    packageName: "@paperclipai/plugin-e2b",
    version: "0.1.0",
    status: "error",
    categories: ["automation"],
    manifestJson: {
      displayName: "E2B Sandbox Provider",
      version: "0.1.0",
      description: "E2B environments for Paperclip.",
      author: "Paperclip",
      capabilities: ["environment.drivers.register"],
      environmentDrivers: [
        {
          driverKey: "e2b",
          kind: "sandbox_provider",
          displayName: "E2B Cloud Sandbox",
        },
      ],
    },
    lastError: null,
    ...overrides,
  };
}

function wikiFolderDeclaration() {
  return {
    folderKey: "wiki-root",
    displayName: "Wiki root",
    description: "Company-scoped local folder that stores wiki files.",
    access: "readWrite" as const,
    requiredDirectories: ["raw", "wiki"],
    requiredFiles: ["WIKI.md", "index.md"],
  };
}

function folderStatus(overrides: Record<string, unknown> = {}) {
  return {
    folderKey: "wiki-root",
    configured: false,
    path: null,
    realPath: null,
    access: "readWrite",
    readable: false,
    writable: false,
    requiredDirectories: ["raw", "wiki"],
    requiredFiles: ["WIKI.md", "index.md"],
    missingDirectories: ["raw", "wiki"],
    missingFiles: ["WIKI.md", "index.md"],
    healthy: false,
    problems: [{ code: "not_configured", message: "No local folder path is configured." }],
    checkedAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  };
}

async function renderSettings(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginSettings />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockPluginsApi.get.mockResolvedValue(basePlugin());
    mockPluginsApi.diagnostics.mockResolvedValue({
      schemaVersion: "sps-plugin-diagnostic/v1",
      pluginId: "plugin-1",
      pluginKey: "paperclip.e2b-sandbox-provider",
      generatedAt: "2026-07-31T00:00:00.000Z",
      facts: [{
        schemaVersion: "sps-plugin-diagnostic/v1",
        id: "plugin-ready",
        occurredAt: "2026-07-31T00:00:00.000Z",
        origin: "core",
        level: "info",
        category: "worker",
        code: "SPS_PLUGIN_RUNTIME_READY",
        message: "Plugin runtime is ready.",
        details: {},
      }],
      runtime: {
        lifecycleStatus: "ready",
        declaredCapabilities: [],
        worker: null,
        scheduler: null,
      },
    });
    mockPluginsApi.dashboard.mockResolvedValue(null);
    mockPluginsApi.health.mockResolvedValue({ pluginId: "plugin-1", status: "ready", healthy: true, checks: [] });
    mockPluginsApi.logs.mockResolvedValue([]);
    mockPluginsApi.migrationPlan.mockResolvedValue(null);
    mockPluginsApi.pendingUpdate.mockResolvedValue(null);
    mockPluginsApi.upgrade.mockResolvedValue({ ok: true });
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [],
      folders: [],
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("routes environment-provider plugins to instance environments when they have no instance config", async () => {
    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configure this plugin from Instance Settings → Environments.");
    expect(container.textContent).toContain("secret bindings still resolve through the selected company context");
    const link = container.querySelector('a[href="/company/settings/instance/environments"]');
    expect(link?.textContent).toContain("Open Environments");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders canonical safe diagnostics without requiring a console", async () => {
    const root = await renderSettings(container);
    const statusButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Status");

    await act(async () => {
      statusButton?.click();
      await Promise.resolve();
    });
    await flushReact();

    expect(container.textContent).toContain("Canonical Diagnostics");
    expect(container.textContent).toContain("SPS_PLUGIN_RUNTIME_READY");
    expect(container.textContent).toContain("Plugin runtime is ready.");

    await act(async () => {
      root.unmount();
    });
  });

  it("requires explicit review before applying a pending capability and data update", async () => {
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      status: "upgrade_pending",
      lastError: "Upgrade review required: target version: 1.1.0; new capabilities: tools.invoke; data migration plan: review-hash",
    }));
    mockPluginsApi.migrationPlan.mockResolvedValue({
      pluginId: "plugin-1",
      pluginKey: "paperclip.e2b-sandbox-provider",
      targetVersion: "1.1.0",
      namespaceName: "plugin_example",
      hasAppliedMigrations: true,
      requiresHostApproval: true,
      reviewHash: "review-hash",
      pendingMigrations: [{
        migrationKey: "002_add_state.sql",
        checksum: "checksum",
        statementCount: 2,
        operationKinds: ["alter", "update"],
      }],
    });
    mockPluginsApi.pendingUpdate.mockResolvedValue({
      stageId: "registry-stage-1",
      pluginId: "paperclip.e2b-sandbox-provider",
      targetVersion: "1.1.0",
      addedCapabilities: ["tools.invoke"],
      migrationPlan: null,
      source: { registryId: "io.sps.example", kind: "official", releaseLocator: "releases/plugin-1.1.0.json" },
      requestedAt: "2026-07-29T00:00:00.000Z",
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Update review required");
    expect(container.textContent).toContain("tools.invoke");
    expect(container.textContent).toContain("002_add_state.sql");
    const approveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Approve and apply update"));
    expect(approveButton).toBeTruthy();
    expect((approveButton as HTMLButtonElement).disabled).toBe(true);

    const capabilityCheckbox = container.querySelector('[id="approve-capabilities-plugin-1"]') as HTMLElement | null;
    const migrationCheckbox = container.querySelector('[id="approve-migrations-plugin-1"]') as HTMLElement | null;
    expect(capabilityCheckbox).toBeTruthy();
    expect(migrationCheckbox).toBeTruthy();

    await act(async () => {
      capabilityCheckbox?.click();
      migrationCheckbox?.click();
      await Promise.resolve();
    });
    await flushReact();

    expect((approveButton as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      (approveButton as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await flushReact();

    expect(mockPluginsApi.upgrade).toHaveBeenCalledWith("plugin-1", {
      version: "1.1.0",
      stageId: "registry-stage-1",
      approvedCapabilityEscalation: true,
      approvedDataMigrationPlanHash: "review-hash",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("renders unconfigured manifest local folders with required paths", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      status: "ready",
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus()],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Local folders");
    expect(container.textContent).toContain("Wiki root");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("No local folder path is configured.");
    expect(container.textContent).toContain("Missing directories: raw, wiki");
    expect(container.textContent).toContain("Missing files: WIKI.md, index.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders invalid configured folders with validation problems", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki",
        realPath: "/tmp/wiki",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: ["WIKI.md"],
        problems: [{ code: "missing_file", message: "Required file is missing.", path: "WIKI.md" }],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Validation problems");
    expect(container.textContent).toContain("Required file is missing.");
    expect(container.textContent).toContain("Missing files: WIKI.md");

    await act(async () => {
      root.unmount();
    });
  });

  it("does not render required paths as present when the configured root cannot be inspected", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki-missing",
        readable: false,
        writable: false,
        missingDirectories: [],
        missingFiles: [],
        problems: [{ code: "missing", message: "Configured local folder cannot be inspected.", path: "/tmp/wiki-missing" }],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Configured local folder cannot be inspected.");
    expect(container.textContent).toContain("Not inspected");
    expect(container.textContent).toContain("Configured root was not inspected.");
    expect(container.textContent).not.toContain("Present");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders healthy folders without validation problems", async () => {
    const declaration = wikiFolderDeclaration();
    mockPluginsApi.get.mockResolvedValue(basePlugin({
      manifestJson: {
        displayName: "LLM Wiki",
        version: "0.1.0",
        description: "Local-file LLM Wiki plugin.",
        author: "Paperclip",
        capabilities: ["local.folders"],
        localFolders: [declaration],
      },
    }));
    mockPluginsApi.listLocalFolders.mockResolvedValue({
      pluginId: "plugin-1",
      companyId: "company-1",
      declarations: [declaration],
      folders: [folderStatus({
        configured: true,
        path: "/tmp/wiki",
        realPath: "/private/tmp/wiki",
        readable: true,
        writable: true,
        missingDirectories: [],
        missingFiles: [],
        healthy: true,
        problems: [],
      })],
    });

    const root = await renderSettings(container);

    expect(container.textContent).toContain("Healthy");
    expect(container.textContent).toContain("Configured path");
    expect(container.textContent).toContain("/tmp/wiki");
    expect(container.textContent).toContain("ReadableYes");
    expect(container.textContent).toContain("WritableYes");
    expect(container.textContent).toContain("Present");
    expect(container.textContent).not.toContain("Validation problems");

    await act(async () => {
      root.unmount();
    });
  });
});
