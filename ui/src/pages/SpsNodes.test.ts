// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import type { CurrentBoardAccess } from "@/api/access";
import { canManageSpsNodes, SpsNodes } from "./SpsNodes";

const mocks = vi.hoisted(() => ({
  getAccess: vi.fn(),
  listNodes: vi.fn(),
  listAgents: vi.fn(),
  setBreadcrumbs: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.getAccess } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/spsNodes", () => ({ spsNodesApi: { list: mocks.listNodes } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "workspace-1", selectedCompany: { name: "SPS Test" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.pushToast }) }));
vi.mock("@/lib/sps-core-baseline-mode", () => ({ isSpsCoreBaselineModeEnabled: () => true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function access(overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess {
  return {
    user: null,
    userId: "user-1",
    isInstanceAdmin: false,
    isCoreHost: false,
    companyIds: ["workspace-1"],
    source: "session",
    keyId: null,
    ...overrides,
  };
}

describe("canManageSpsNodes", () => {
  it("allows only the local Host bridge in SPS Core baseline mode", () => {
    expect(canManageSpsNodes("workspace-1", access({ source: "local_implicit" }), true)).toBe(true);
    expect(canManageSpsNodes("workspace-1", access({ isCoreHost: true }), true)).toBe(true);
    expect(canManageSpsNodes("workspace-1", access({ isInstanceAdmin: true }), true)).toBe(false);
  });

  it("keeps the legacy instance-admin rule outside SPS Core baseline mode", () => {
    expect(canManageSpsNodes("workspace-1", access({ isInstanceAdmin: true }), false)).toBe(true);
  });

  it("keeps technical Agent-to-Node grants visible to the SPS Host in baseline mode", async () => {
    const source = await readFile(new NodeURL("./SpsNodes.tsx", import.meta.url), "utf8");

    expect(source).toContain("enabled: !!selectedCompanyId && canManageNodes === true,");
    expect(source).not.toContain("canManageNodes === true && !spsCoreBaseline");
    expect(source).not.toContain("{!spsCoreBaseline ? <div");
  });
});

describe("SpsNodes access recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccess.mockReset();
    mocks.listNodes.mockResolvedValue([]);
    mocks.listAgents.mockResolvedValue([]);
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

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it.each([true, false])("shows an access error and retries into the correct Host access state (%s)", async (isCoreHost) => {
    mocks.getAccess.mockRejectedValueOnce(new Error("Access service temporarily unavailable"))
      .mockResolvedValue(access({ isCoreHost }));
    act(() => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(SpsNodes)));
    });
    await settle();
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Access service temporarily unavailable");
    expect(container.textContent).not.toContain("Checking SPS Node access...");
    expect(mocks.listNodes).not.toHaveBeenCalled();
    expect(mocks.listAgents).not.toHaveBeenCalled();
    const retry = container.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toContain("Retry access");
    expect(retry?.disabled).toBe(false);

    act(() => retry?.click());
    await settle();
    await settle();
    expect(mocks.getAccess).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Checking SPS Node access...");
    if (isCoreHost) {
      expect(mocks.listNodes).toHaveBeenCalledWith("workspace-1");
      expect(mocks.listAgents).toHaveBeenCalledWith("workspace-1");
      expect(container.textContent).toContain("No computers are registered yet.");
    } else {
      expect(mocks.listNodes).not.toHaveBeenCalled();
      expect(mocks.listAgents).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Only the Host manages the shared computer inventory");
    }
  });
});
