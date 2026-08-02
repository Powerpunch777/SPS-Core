// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../components/ui/tooltip";
import { CompanyImport } from "./CompanyImport";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "workspace-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    importPreview: vi.fn(),
    importBundle: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock("../api/sidebarPreferences", () => ({
  sidebarPreferencesApi: { updateProjectOrder: vi.fn() },
}));

vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: () => null }));
vi.mock("../components/AgentConfigForm", () => ({ AgentConfigForm: () => null }));
vi.mock("../components/FileTree", () => ({
  FileTree: () => null,
  buildFileTree: () => [],
  countFiles: () => 0,
  collectAllPaths: () => [],
  parseFrontmatter: () => null,
}));
vi.mock("../adapters", () => ({
  getUIAdapter: () => ({ buildAdapterConfig: () => ({}) }),
  listUIAdapters: () => [],
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanyImport", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("exposes only new Workspace import controls", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <QueryClientProvider client={queryClient}>
            <CompanyImport />
          </QueryClientProvider>
        </TooltipProvider>,
      );
    });

    expect(container.textContent).toContain("Creates a new Workspace");
    expect(container.textContent).toContain("New Workspace name");
    expect(container.textContent).not.toContain("Existing company:");
    expect(container.textContent).not.toContain("Collision strategy");
    expect(container.textContent).not.toContain("Replace existing");
    expect(container.textContent).not.toContain("Skip on conflict");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Workspace", href: "/org" },
      { label: "Import Workspace" },
    ]);

    await act(async () => { root.unmount(); });
  });
});
