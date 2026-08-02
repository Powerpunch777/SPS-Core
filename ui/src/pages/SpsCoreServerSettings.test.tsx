// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsCoreServerSettings } from "./SpsCoreServerSettings";

const setBreadcrumbs = vi.hoisted(() => vi.fn());
const bridge = {
  getServerSettings: vi.fn(),
  enablePrivateTeamAccess: vi.fn(),
  disablePrivateTeamAccess: vi.fn(),
  installAgentRuntimePack: vi.fn(),
  createMemberInvite: vi.fn(),
  listMemberInvites: vi.fn(),
  revokeMemberInvite: vi.fn(),
  signOutDesktopAccount: vi.fn(),
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "workspace-1", name: "SPS Test" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsCoreServerSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    bridge.getServerSettings.mockResolvedValue({
      desktopAccount: { signedIn: true, name: "Host", email: "host@example.com" },
      ownerHost: { state: "running", url: "http://127.0.0.1:31310", lastError: null },
      teamAccess: null,
      ownerHostCompanies: [{ id: "workspace-1", name: "SPS Test" }],
      agentRuntimePacks: [],
    });
    bridge.enablePrivateTeamAccess.mockResolvedValue(undefined);
    bridge.listMemberInvites.mockResolvedValue([]);
    (window as Window & { spsDesktopWorkspace?: typeof bridge }).spsDesktopWorkspace = bridge;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    delete (window as Window & { spsDesktopWorkspace?: typeof bridge }).spsDesktopWorkspace;
    vi.clearAllMocks();
  });

  it("keeps private-team controls inside Host settings and uses the selected Workspace", async () => {
    const root = createRoot(container);
    await act(async () => { root.render(<SpsCoreServerSettings />); });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("SPS Server");
    expect(container.textContent).toContain("Private team access");
    const enable = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Enable private access"));
    await act(async () => { enable?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    expect(bridge.enablePrivateTeamAccess).toHaveBeenCalledWith({ companyId: "workspace-1" });
    expect(setBreadcrumbs).toHaveBeenCalledWith([
      { label: "SPS Test", href: "/dashboard" },
      { label: "Host settings", href: "/company/settings" },
      { label: "SPS Server" },
    ]);

    await act(async () => { root.unmount(); });
  });
});
