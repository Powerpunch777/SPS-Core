// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listInbox: vi.fn(),
  setInboxState: vi.fn(),
  performInboxAction: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({ navigate: vi.fn() }));
const breadcrumbMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/workspace-surfaces", () => ({
  workspaceSurfacesApi: apiMocks,
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "workspace-1", name: "Prototype Workspace" },
    selectedCompanyId: "workspace-1",
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: breadcrumbMock }),
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => routerMock.navigate }));

import { SpsWorkspaceInbox } from "./SpsWorkspaceInbox";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function inboxItem(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: "workspace-1",
    sourcePluginId: "plugin-1",
    sourcePluginKey: "workflow-kit",
    sourcePluginDisplayName: "Workflow Kit",
    externalId: id,
    targetUserId: null,
    category: "report",
    severity: "info",
    title,
    summary: `${title} summary`,
    navigationTarget: `/work/${id}`,
    actionIds: ["acknowledge"],
    actions: [{ id: "acknowledge", displayName: "Acknowledge", destructive: false }],
    opaqueReference: {},
    withdrawnAt: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    unread: true,
    readAt: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("SpsWorkspaceInbox", () => {
  let container: HTMLDivElement;
  let root: Root;
  const active = [
    inboxItem("unread", "Build needs review"),
    inboxItem("read", "Deployment complete", { unread: false, readAt: "2026-07-31T00:01:00.000Z" }),
  ];
  const archived = [
    inboxItem("archived", "Old report", { unread: false, archivedAt: "2026-07-30T00:00:00.000Z" }),
  ];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    apiMocks.listInbox.mockImplementation((_companyId: string, options?: { archived?: boolean }) =>
      Promise.resolve({ items: options?.archived ? archived : active }),
    );
    apiMocks.setInboxState.mockResolvedValue({ readAt: "2026-07-31T00:02:00.000Z", archivedAt: null });
    apiMocks.performInboxAction.mockResolvedValue({ data: { ok: true } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(<QueryClientProvider client={queryClient}><SpsWorkspaceInbox /></QueryClientProvider>);
    });
  }

  it("filters all, unread, archived items and searches visible Inbox reports", async () => {
    render();
    await settle();
    await settle();
    expect(container.textContent).toContain("Build needs review");
    expect(container.textContent).toContain("Deployment complete");

    const unread = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find((button) => button.textContent === "Unread");
    act(() => unread?.click());
    await settle();
    expect(container.textContent).toContain("Build needs review");
    expect(container.textContent).not.toContain("Deployment complete");

    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search Inbox"]');
    expect(search).not.toBeNull();
    act(() => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "nothing");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(container.textContent).toContain("No items match your search.");

    act(() => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const archivedTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find((button) => button.textContent === "Archived");
    act(() => archivedTab?.click());
    await settle();
    await settle();
    expect(apiMocks.listInbox).toHaveBeenCalledWith("workspace-1", { archived: true });
    expect(container.textContent).toContain("Old report");
  });

  it("marks an unread report read and opens its plugin navigation target", async () => {
    render();
    await settle();
    await settle();
    const itemButton = Array.from(container.querySelectorAll<HTMLButtonElement>('article button')).find((button) => button.textContent?.includes("Build needs review"));
    expect(itemButton).not.toBeNull();
    act(() => itemButton?.click());
    await settle();

    expect(apiMocks.setInboxState).toHaveBeenCalledWith("workspace-1", "unread", { read: true });
    expect(routerMock.navigate).toHaveBeenCalledWith("/work/unread");
  });

  it("archives a report and dispatches a declared plugin action", async () => {
    render();
    await settle();
    await settle();

    const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive Build needs review"]');
    act(() => archiveButton?.click());
    await settle();
    expect(apiMocks.setInboxState).toHaveBeenCalledWith("workspace-1", "unread", { archived: true });

    const actionButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Acknowledge");
    act(() => actionButton?.click());
    await settle();
    expect(apiMocks.performInboxAction).toHaveBeenCalledWith("workspace-1", "unread", "acknowledge");
  });
});
