// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativePluginContext, SpsNativePluginBridge } from "../native-plugin-bridge";
import { createNativePluginSdk } from "./native-plugin-sdk";

describe("Native Plugin SDK bridge", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("forwards data and action calls through the fixed preload methods and rejects Host-only hooks", async () => {
    const bridge: SpsNativePluginBridge = {
      bootstrap: vi.fn(),
      getData: vi.fn(async () => ({ data: { ok: true } })),
      performAction: vi.fn(async () => ({ data: { saved: true } })),
    };
    const context: NativePluginContext = { companyId: "workspace-1", companyPrefix: "WS", projectId: null,
      entityId: null, entityType: null, userId: "member-1" };
    const sdk = createNativePluginSdk(bridge, context, {}, {});
    let actionResult: unknown;
    function Consumer() {
      const result = sdk.sdkUi.usePluginData("summary", { range: "week" });
      const run = sdk.sdkUi.usePluginAction("save");
      return <button onClick={() => { void run({ enabled: true }).then(value => { actionResult = value; }); }}>
        {result.loading ? "loading" : JSON.stringify(result.data)}
      </button>;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Consumer />));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(bridge.getData).toHaveBeenCalledWith("summary", { range: "week" });
    expect(container.textContent).toContain('{"ok":true}');
    await act(async () => { container?.querySelector("button")?.click(); await Promise.resolve(); });
    expect(bridge.performAction).toHaveBeenCalledWith("save", { enabled: true });
    expect(actionResult).toEqual({ saved: true });
    expect(() => sdk.sdkUi.usePluginStream()).toThrow("does not provide Plugin streams");
    expect(sdk.sdkUi.useHostContext()).toEqual(context);
  });
});
