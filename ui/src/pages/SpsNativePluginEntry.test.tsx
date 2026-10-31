// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpsNativePluginBridge } from "../native-plugin-bridge";
import { SpsNativePluginEntry } from "./SpsNativePluginEntry";

const loaderControl = vi.hoisted(() => ({ install: vi.fn(), dispose: vi.fn(), importModule: vi.fn() }));
vi.mock("../plugins/module-loader", () => ({
  createPluginModuleLoader: () => ({
    installImportMap: loaderControl.install,
    dispose: loaderControl.dispose,
    importModule: loaderControl.importModule,
    rewriteBareSpecifiers: (source: string) => source,
  }),
}));

const workspaceId = "f8b80a0e-4503-4ead-904e-813c6d5e0acd";
const descriptor = (surface: "shell" | "widget") => ({
  v: 1,
  kind: "sps.native.plugin.surface",
  workspaceId,
  pluginId: "plugin-1",
  pluginKey: "workflow-kit",
  displayName: "Workflow Kit",
  revision: "a".repeat(64),
  surface,
  surfaceId: surface === "widget" ? "widget-1" : "shell-1",
  entryFile: "index.js",
  exportName: surface === "widget" ? "DashboardWidget" : "WorkspacePage",
  widget: surface === "widget" ? { id: "widget-1", exportName: "DashboardWidget", displayName: "Current status", dataAction: "summary" } : null,
  slot: surface === "shell" ? { id: "workspace-page", type: "page", exportName: "WorkspacePage", routePath: "/" } : null,
  cssFiles: ["styles.css"],
});

describe("SpsNativePluginEntry", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).__spsNativePluginBridge__;
  });

  async function mount(bridge: SpsNativePluginBridge) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<SpsNativePluginEntry bridge={bridge} />));
  }

  it("mounts the declared shell export with the original slot and Native host context", async () => {
    const bridge = { bootstrap: vi.fn(async () => ({ descriptor: descriptor("shell"), workspace: { id: workspaceId, name: "Workspace", issuePrefix: "WS" }, member: { userId: "member-1" } })), getData: vi.fn(), performAction: vi.fn() } satisfies SpsNativePluginBridge;
    loaderControl.importModule.mockResolvedValue({ WorkspacePage: (props: Record<string, unknown>) => <output>{JSON.stringify(props)}</output> });
    await mount(bridge);
    expect(loaderControl.install).toHaveBeenCalledOnce();
    expect(loaderControl.importModule).toHaveBeenCalledWith("/plugin/index.js");
    expect(container?.textContent).toContain('"slot":{"id":"workspace-page"');
    expect(container?.textContent).toContain(`"companyId":"${workspaceId}"`);
    expect(bridge.getData).not.toHaveBeenCalled();
  });

  it("prefetches declared widget data and mounts with the dashboard widget contract", async () => {
    const bridge = { bootstrap: vi.fn(async () => ({ descriptor: descriptor("widget"), workspace: { id: workspaceId, name: "Workspace", issuePrefix: "WS" }, member: { userId: "member-1" } })), getData: vi.fn(async () => ({ data: { status: "healthy" } })), performAction: vi.fn() } satisfies SpsNativePluginBridge;
    loaderControl.importModule.mockResolvedValue({ DashboardWidget: (props: Record<string, unknown>) => <output>{JSON.stringify(props)}</output> });
    await mount(bridge);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(bridge.getData).toHaveBeenCalledWith("summary", { companyId: workspaceId });
    expect(container?.textContent).toContain('"widget":{"id":"widget-1"');
    expect(container?.textContent).toContain('"data":{"status":"healthy"}');
    expect(container?.textContent).toContain('"loading":false');
  });

  it("fails closed on an expanded descriptor before importing plugin code", async () => {
    const malformed = { ...descriptor("shell"), arbitraryUrl: "https://example.invalid/plugin.js" };
    const bridge = { bootstrap: vi.fn(async () => ({ descriptor: malformed, workspace: { id: workspaceId, name: "Workspace", issuePrefix: "WS" }, member: { userId: "member-1" } })), getData: vi.fn(), performAction: vi.fn() } satisfies SpsNativePluginBridge;
    await mount(bridge);
    expect(container?.textContent).toContain("Plugin view is unavailable");
    expect(loaderControl.install).not.toHaveBeenCalled();
    expect(loaderControl.importModule).not.toHaveBeenCalled();
  });
});
