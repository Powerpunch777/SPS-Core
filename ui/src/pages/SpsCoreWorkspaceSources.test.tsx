// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreWorkspaceSources } from "./SpsCoreWorkspaceSources";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const source = { id: "source_001", name: "Client", sourcePath: "C:\\Projects\\client" };
const bridge = {
  listHostWorkspaceSources: vi.fn(),
  chooseHostWorkspaceSource: vi.fn(),
  renameHostWorkspaceSource: vi.fn(),
  removeHostWorkspaceSource: vi.fn(),
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "workspace-1", name: "Prototype Workspace" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsCoreWorkspaceSources", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    bridge.listHostWorkspaceSources.mockResolvedValue({ privateTeamAccessEnabled: true, sources: [source] });
    (window as Window & { spsDesktopWorkspace?: typeof bridge }).spsDesktopWorkspace = bridge;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    delete (window as Window & { spsDesktopWorkspace?: typeof bridge }).spsDesktopWorkspace;
    vi.clearAllMocks();
  });

  it("lists only Host-managed named source handles", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<SpsCoreWorkspaceSources />);
    });
    await flushReact();
    await flushReact();

    expect(bridge.listHostWorkspaceSources).toHaveBeenCalledOnce();
    expect((container.querySelector("input") as HTMLInputElement | null)?.value).toBe("Client");
    expect(container.textContent).toContain("C:\\Projects\\client");
    expect(container.textContent).toContain("Removing it removes the SPS handle, never the folder or its files.");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Prototype Workspace", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "Sources" },
    ]);

    await act(async () => { root.unmount(); });
  });

  it("does not expose a source picker when the Desktop Host bridge is unavailable", async () => {
    delete (window as Window & { spsDesktopWorkspace?: typeof bridge }).spsDesktopWorkspace;
    const root = createRoot(container);
    await act(async () => {
      root.render(<SpsCoreWorkspaceSources />);
    });
    await flushReact();

    expect(container.textContent).toContain("Only the SPS Host can choose folders for this Workspace.");
    expect(container.textContent).toContain("This Member computer cannot substitute a local folder.");
    expect(container.textContent).not.toContain("Add folder");

    await act(async () => { root.unmount(); });
  });
});
