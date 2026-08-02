// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreAssistantDetail } from "./SpsCoreAssistantDetail";

const mockAgentsApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockConfigProps = vi.hoisted(() => vi.fn());

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/components/AgentConfigForm", () => ({
  AgentConfigForm: (props: {
    onSave: (patch: Record<string, unknown>) => void;
    hideWorkflowIdentityFields?: boolean;
    hidePromptTemplate?: boolean;
  }) => {
    mockConfigProps(props);
    return <button type="button" onClick={() => props.onSave({ name: "Updated Assistant" })}>Save runtime</button>;
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "workspace-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to }: { to: string }) => <span data-redirect={to} />,
  useParams: () => ({ agentId: "assistant-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("SpsCoreAssistantDetail", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.get.mockResolvedValue({
      id: "assistant-1",
      companyId: "workspace-1",
      name: "Assistant",
      title: "Initial Assistant",
      adapterType: "codex_local",
      status: "idle",
    });
    mockAgentsApi.update.mockResolvedValue({ id: "assistant-1", name: "Updated Assistant" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows only neutral runtime settings and saves through the Assistant API", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SpsCoreAssistantDetail />
        </QueryClientProvider>,
      );
    });

    for (let index = 0; index < 8 && !container.textContent?.includes("Runtime configuration"); index += 1) {
      await act(async () => {
        await flushReact();
      });
    }

    expect(container.textContent).toContain("Runtime configuration");
    expect(container.textContent).toContain("Open Plugins");
    expect(container.innerHTML).toContain('href="/company/settings/instance/plugins"');
    expect(container.textContent).not.toContain("Assign Task");
    expect(container.textContent).not.toContain("Reports to");
    expect(mockConfigProps).toHaveBeenCalledWith(expect.objectContaining({
      hideWorkflowIdentityFields: true,
      hidePromptTemplate: true,
    }));

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await flushReact();
    });
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "assistant-1",
      { name: "Updated Assistant" },
      "workspace-1",
    );

    await act(async () => {
      root.unmount();
    });
  });
});
