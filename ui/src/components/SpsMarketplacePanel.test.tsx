// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpsMarketplacePanel } from "./SpsMarketplacePanel";

const marketplace = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listAssistantAgents: vi.fn(),
  openAssistantSession: vi.fn(),
  listAssistantMessages: vi.fn(),
  sendAssistantMessage: vi.fn(),
  closeAssistantSession: vi.fn(),
}));
vi.mock("@/api/sps-marketplace", () => ({ spsMarketplaceApi: marketplace }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function renderPanel(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><SpsMarketplacePanel companyId="workspace-1" /></QueryClientProvider>);
  });
  return root;
}

async function waitForText(container: HTMLDivElement, text: string) {
  for (let index = 0; index < 12; index += 1) {
    if (container.textContent?.includes(text)) return;
    await act(async () => flushReact());
  }
}

const plugin = {
  pluginId: "io.sps.example",
  displayName: "Example Plugin",
  version: "1.0.0",
  summary: "Verified example.",
  categories: ["workflow"],
  capabilities: ["agent.tools.register"],
  publisher: "SPS",
  compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0" },
  trust: "official" as const,
};

describe("SpsMarketplacePanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    marketplace.list.mockResolvedValue({ plugins: [plugin], total: 1, source: { id: "io.sps.official", displayName: "SPS Official Registry" }, refreshedAt: null });
    marketplace.get.mockResolvedValue({ plugin: { ...plugin, description: "A detailed verified example.", documentationUrl: null } });
    marketplace.listAssistantAgents.mockResolvedValue({ agents: [{ id: "agent-1", name: "SPS Guide", title: "Marketplace Guide", icon: null, adapterType: "codex", status: "active" }] });
    marketplace.openAssistantSession.mockResolvedValue({ session: { id: "session-1", companyId: "workspace-1", userId: "user-1", agentId: "agent-1", adapterType: "codex", taskKey: "sps-marketplace-assistant", sessionDisplayId: null, status: "active", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T00:00:00.000Z", closedAt: null } });
    marketplace.listAssistantMessages.mockResolvedValue({ messages: [], nextCursor: null });
    marketplace.sendAssistantMessage.mockResolvedValue({ message: { id: "message-1", sessionId: "session-1", runId: "run-1", idempotencyKey: "key-1", role: "user", content: "Find a plugin", metadata: {}, createdAt: "2026-07-31T00:00:00.000Z" }, run: { id: "run-1", status: "queued" } });
    marketplace.closeAssistantSession.mockResolvedValue({ session: { id: "session-1", status: "closed" } });
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps public Marketplace search independent from the Assistant", async () => {
    const root = await renderPanel(container);
    await waitForText(container, "Example Plugin");
    expect(marketplace.list).toHaveBeenCalledWith("workspace-1", { query: "", limit: 50 });
    expect(marketplace.listAssistantAgents).toHaveBeenCalledWith("workspace-1");
    expect(container.textContent).toContain("Example Plugin");
    expect(container.textContent).toContain("Plugin lifecycle actions remain manual Host controls in Settings > Plugins.");
    expect(container.textContent).not.toMatch(/Install|Enable|Disable|Update|Remove/);
    await act(async () => root.unmount());
  });

  it("selects an Agent, opens a session, sends a message, and reflects the polled answer", async () => {
    let pollCount = 0;
    marketplace.listAssistantMessages.mockImplementation(async () => ({
      messages: pollCount++ < 2 ? [] : [
        { id: "message-1", sessionId: "session-1", runId: "run-1", idempotencyKey: "key-1", role: "user", content: "Find a plugin", metadata: {}, createdAt: "2026-07-31T00:00:00.000Z" },
        { id: "message-2", sessionId: "session-1", runId: "run-1", idempotencyKey: "key-2", role: "assistant", content: "Example Plugin matches your request.", metadata: {}, createdAt: "2026-07-31T00:00:01.000Z" },
      ], nextCursor: null,
    }));
    const root = await renderPanel(container);
    await waitForText(container, "Choose an Agent");
    const agentSelect = container.querySelector<HTMLSelectElement>("#marketplace-assistant-agent");
    expect(agentSelect).not.toBeNull();
    await act(async () => {
      if (agentSelect) {
        agentSelect.value = "agent-1";
        agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open");
    await act(async () => openButton?.click());
    await waitForText(container, "Conversation");
    expect(marketplace.openAssistantSession).toHaveBeenCalledWith("workspace-1", "agent-1");
    expect(container.textContent).toContain("Conversation");

    const input = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Assistant message']");
    expect(input).not.toBeNull();
    await act(async () => {
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(input, "Find a plugin");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const sendButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Send"));
    await act(async () => sendButton?.click());
    await act(async () => flushReact());
    expect(marketplace.sendAssistantMessage).toHaveBeenCalledWith("workspace-1", "session-1", "Find a plugin", expect.any(String));
    expect(container.textContent).toContain("Working");

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1700));
    });
    await act(async () => flushReact());
    expect(container.textContent).toContain("Example Plugin matches your request.");
    expect(container.textContent).not.toContain("Working");
    await act(async () => root.unmount());
  });

  it("shows an explicit no-Agent state and does not create a session", async () => {
    marketplace.listAssistantAgents.mockResolvedValue({ agents: [] });
    const root = await renderPanel(container);
    await waitForText(container, "No Agent is available for Marketplace Assistant.");
    expect(container.textContent).toContain("No Agent is available for Marketplace Assistant.");
    expect(marketplace.openAssistantSession).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows a failed run from the transcript and leaves the Working state", async () => {
    marketplace.listAssistantMessages.mockResolvedValue({
      messages: [{
        id: "message-error",
        sessionId: "session-1",
        runId: "run-1",
        idempotencyKey: "system:run-1",
        role: "system",
        content: "Marketplace Assistant failed: provider unavailable",
        metadata: { outcome: "failed" },
        createdAt: "2026-07-31T00:00:01.000Z",
      }],
      nextCursor: null,
    });
    const root = await renderPanel(container);
    await waitForText(container, "Choose an Agent");
    const agentSelect = container.querySelector<HTMLSelectElement>("#marketplace-assistant-agent");
    await act(async () => {
      if (agentSelect) {
        agentSelect.value = "agent-1";
        agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open");
    await act(async () => openButton?.click());
    await waitForText(container, "Marketplace Assistant failed: provider unavailable");
    expect(container.textContent).toContain("Marketplace Assistant failed: provider unavailable");
    expect(container.textContent).not.toContain("Working");
    await act(async () => root.unmount());
  });
});
