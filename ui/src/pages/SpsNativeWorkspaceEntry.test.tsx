// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeWorkspaceBootstrap, SpsNativeWorkspaceBridge } from "../native-workspace-bridge";
import { SpsNativeWorkspaceEntry } from "./SpsNativeWorkspaceEntry";

const bootstrap: NativeWorkspaceBootstrap = {
  v: 1,
  kind: "sps.native.workspace.bootstrap",
  workspace: { id: "f8b80a0e-4503-4ead-904e-813c6d5e0acd", name: "München Workspace", issuePrefix: "MNCH" },
  member: { userId: "member-123" },
  capabilities: ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read"],
};

function neutralShell(fallbackReason: string | null = null) {
  return { mode: "neutral", providerPluginId: null, providerPluginKey: null, shell: null, fallbackReason };
}

function widget(displayName: string, description?: string) {
  return {
    pluginId: "plugin-1",
    pluginKey: "workflow-kit",
    pluginDisplayName: "Workflow Kit",
    widget: {
      id: "widget-1",
      displayName,
      ...(description === undefined ? {} : { description }),
      exportName: "Widget",
      sizes: ["small"],
      defaultSize: "small",
      defaultOrder: 0,
      dataAction: "list",
    },
    layout: { size: "small", position: 0, collapsed: false, source: "default" },
  };
}

function inboxItem(title: string) {
  return {
    id: "inbox-1",
    companyId: bootstrap.workspace.id,
    sourcePluginId: "plugin-1",
    sourcePluginKey: "workflow-kit",
    sourcePluginDisplayName: "Workflow Kit",
    externalId: "external-1",
    targetUserId: bootstrap.member.userId,
    category: "workflow",
    severity: "info",
    title,
    summary: "Member-visible summary",
    navigationTarget: "/owner-only/plugin-route",
    actionIds: ["approve"],
    actions: [{ id: "approve", displayName: "Approve", action: "approve" }],
    opaqueReference: { secret: "do not render" },
    withdrawnAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    unread: true,
    readAt: null,
    archivedAt: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function click(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
  await settle();
}

describe("SpsNativeWorkspaceEntry", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootUnmounted: boolean;
  let bridge: SpsNativeWorkspaceBridge;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rootUnmounted = false;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    bridge = {
      getBootstrap: vi.fn().mockResolvedValue(bootstrap),
      readSurface: vi.fn(async ({ surface }) => {
        if (surface === "shell") return neutralShell();
        if (surface === "dashboard") return { widgets: [] };
        if (surface === "inbox") return { items: [] };
        return [];
      }),
    };
  });

  afterEach(() => {
    if (!rootUnmounted) act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function render() {
    act(() => root.render(<SpsNativeWorkspaceEntry bridge={bridge} />));
  }

  it("bootstraps the real neutral Workspace and uses the Main bridge without ordinary API fetches", async () => {
    render();
    await settle();

    expect(bridge.getBootstrap).toHaveBeenCalledOnce();
    expect(bridge.readSurface).toHaveBeenCalledWith({ surface: "shell" });
    expect(container.textContent).toContain("München Workspace");
    expect(container.textContent).toContain("No default plugin selected.");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders real dashboard and inbox public text without following plugin actions or navigation targets", async () => {
    bridge.readSurface = vi.fn(async ({ surface }) => {
      if (surface === "shell") return neutralShell();
      if (surface === "dashboard") return { widgets: [widget("Member dashboard", "Current workspace status")] };
      if (surface === "inbox") return { items: [inboxItem("Member inbox item")] };
      return [];
    });
    render();
    await settle();

    await click(container, "Dashboard");
    expect(container.textContent).toContain("Member dashboard");
    expect(container.textContent).toContain("Current workspace status");
    expect(container.textContent).toContain("These widgets are configured for this Workspace.");
    expect(container.textContent).toContain("Their Plugin views are not available on this Native connection yet.");
    expect(container.textContent).not.toContain("dataAction");

    await click(container, "Inbox");
    expect(container.textContent).toContain("Member inbox item");
    expect(container.textContent).toContain("Member-visible summary");
    expect(container.textContent).not.toContain("/owner-only/plugin-route");
    expect(container.textContent).not.toContain("Approve");
    expect(container.textContent).not.toContain("do not render");
    expect(container.querySelector("a")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a selected Plugin Shell as unavailable rather than showing the neutral empty state", async () => {
    bridge.readSurface = vi.fn().mockResolvedValue({
      mode: "plugin", providerPluginId: "plugin-1", providerPluginKey: "workflow-kit",
      shell: { id: "workflow", displayName: "Workflow", defaultRoute: "/plugins/workflow" }, fallbackReason: null,
    });
    render();
    await settle();

    expect(container.textContent).toContain("selected Plugin Shell");
    expect(container.textContent).toContain("not available in this Native connection");
    expect(container.textContent).not.toContain("No default plugin selected.");
    expect(container.textContent).not.toContain("/plugins/workflow");
  });

  it("disables view navigation during reads and ignores a late response after unmount", async () => {
    let finishDashboard!: (value: unknown) => void;
    render();
    await settle();
    bridge.readSurface = vi.fn(({ surface }) => surface === "dashboard"
      ? new Promise(resolve => { finishDashboard = resolve; })
      : Promise.resolve(neutralShell()));
    await click(container, "Dashboard");
    const inboxButton = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === "Inbox");
    expect(inboxButton?.disabled).toBe(true);
    act(() => {
      root.unmount();
      rootUnmounted = true;
    });
    await act(async () => { finishDashboard({ widgets: [widget("Late dashboard")] }); });
    await settle();
    expect(container.textContent).not.toContain("Late dashboard");
  });

  it("clears stale content and workspace names when a refresh fails", async () => {
    let dashboardReads = 0;
    bridge.readSurface = vi.fn(async ({ surface }) => {
      if (surface === "shell") return neutralShell();
      if (surface === "dashboard" && dashboardReads++ === 0) return { widgets: [widget("Cached dashboard")] };
      if (surface === "dashboard") throw new Error("private detail must not reach UI");
      if (surface === "inbox") return { items: [] };
      return [];
    });
    render();
    await settle();
    await click(container, "Dashboard");
    expect(container.textContent).toContain("Cached dashboard");
    await click(container, "Refresh");

    expect(container.textContent).toContain("Workspace could not be loaded.");
    expect(container.textContent).not.toContain("München Workspace");
    expect(container.textContent).not.toContain("private detail must not reach UI");
    expect(container.textContent).not.toContain("Cached dashboard");
  });

  it("rejects a malformed bootstrap before making a surface request", async () => {
    bridge.getBootstrap = vi.fn().mockResolvedValue({ ...bootstrap, capabilities: ["workspace.shell.read"] });
    render();
    await settle();

    expect(bridge.readSurface).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Workspace could not be loaded.");
    expect(container.textContent).not.toContain("München Workspace");
  });

  it("ignores the stale StrictMode bootstrap completion and reads the shell once", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    bridge.getBootstrap = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    act(() => root.render(<StrictMode><SpsNativeWorkspaceEntry bridge={bridge} /></StrictMode>));
    expect(bridge.getBootstrap).toHaveBeenCalledTimes(2);

    await act(async () => { resolveFirst(bootstrap); await Promise.resolve(); });
    expect(bridge.readSurface).not.toHaveBeenCalled();
    await act(async () => { resolveSecond(bootstrap); await Promise.resolve(); });
    await settle();

    expect(bridge.readSurface).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("No default plugin selected.");
    expect(container.textContent).not.toContain("Workspace could not be loaded.");
  });
});
