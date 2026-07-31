// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsMarketplacePanel } from "./SpsMarketplacePanel";

const marketplace = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/api/sps-marketplace", () => ({ spsMarketplaceApi: marketplace }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("SpsMarketplacePanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    marketplace.list.mockResolvedValue({
      plugins: [{
        pluginId: "io.sps.example",
        displayName: "Example Plugin",
        version: "1.0.0",
        summary: "Verified example.",
        categories: ["workflow"],
        capabilities: ["agent.tools.register"],
        publisher: "SPS",
        compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0" },
        trust: "official",
      }],
      total: 1,
      source: { id: "io.sps.official", displayName: "SPS Official Registry" },
      refreshedAt: "2026-07-31T00:00:00.000Z",
    });
    marketplace.get.mockResolvedValue({
      plugin: {
        pluginId: "io.sps.example",
        displayName: "Example Plugin",
        version: "1.0.0",
        summary: "Verified example.",
        description: "A detailed verified example.",
        categories: ["workflow"],
        capabilities: ["agent.tools.register"],
        publisher: "SPS",
        compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0" },
        trust: "official",
        documentationUrl: null,
      },
    });
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("searches public metadata and keeps installation outside the Assistant", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><SpsMarketplacePanel companyId="workspace-1" /></QueryClientProvider>);
    });
    for (let index = 0; index < 8 && !container.textContent?.includes("Example Plugin"); index += 1) {
      await act(async () => flushReact());
    }

    expect(container.textContent).toContain("Example Plugin");
    expect(container.textContent).toContain("No install or lifecycle tools");
    expect(container.textContent).not.toContain("Install Plugin");

    const pluginButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Example Plugin"));
    await act(async () => {
      pluginButton?.click();
    });
    for (let index = 0; index < 8 && !container.textContent?.includes("A detailed verified example."); index += 1) {
      await act(async () => flushReact());
    }
    expect(marketplace.get).toHaveBeenCalledWith("workspace-1", "io.sps.example");
    expect(container.textContent).toContain("A detailed verified example.");

    await act(async () => root.unmount());
  });
});
