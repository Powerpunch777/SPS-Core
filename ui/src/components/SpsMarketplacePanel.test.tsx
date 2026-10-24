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

async function renderPanel(container: HTMLDivElement, companyId = "workspace-1") {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><SpsMarketplacePanel companyId={companyId} /></QueryClientProvider>);
  });
  return { root, queryClient };
}

async function renderWorkspace(root: ReturnType<typeof createRoot>, queryClient: QueryClient, companyId: string) {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}><SpsMarketplacePanel companyId={companyId} /></QueryClientProvider>);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function selectAssistantAgent(container: HTMLDivElement) {
  await waitForText(container, "Choose an Agent");
  const select = container.querySelector<HTMLSelectElement>("#marketplace-assistant-agent");
  expect(select).not.toBeNull();
  await act(async () => {
    if (select) {
      select.value = "agent-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

async function openAssistantSession(container: HTMLDivElement) {
  await selectAssistantAgent(container);
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Open");
  expect(button).toBeTruthy();
  await act(async () => button?.click());
  await waitForText(container, "Conversation");
}

function changeAssistantDraft(container: HTMLDivElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Assistant message']");
  expect(textarea).not.toBeNull();
  if (!textarea) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  return textarea;
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
    const { root } = await renderPanel(container);
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
    const { root } = await renderPanel(container);
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
    const { root } = await renderPanel(container);
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
    const { root } = await renderPanel(container);
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

  it("resets Workspace session state and ignores deferred open, send, and close results after switching", async () => {
    const deferredOpen = deferred<{ session: { id: string } }>();
    marketplace.openAssistantSession.mockReturnValueOnce(deferredOpen.promise);
    const { root, queryClient } = await renderPanel(container);
    await selectAssistantAgent(container);

    const openButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open");
    expect(openButton).toBeTruthy();
    await act(async () => openButton?.click());
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => openButton?.click());
    expect(marketplace.openAssistantSession).toHaveBeenCalledTimes(1);

    await renderWorkspace(root, queryClient, "workspace-2");
    await waitForText(container, "Choose an Agent");
    deferredOpen.resolve({ session: { id: "old-open-session" } });
    await act(async () => deferredOpen.promise);
    await flushReact();
    expect(container.querySelector('[aria-label="Assistant transcript"]')).toBeNull();
    expect(container.querySelector('[aria-label="New conversation"]')).toBeNull();

    await openAssistantSession(container);
    const deferredSend = deferred<{ run: { id: string } }>();
    marketplace.sendAssistantMessage.mockReturnValueOnce(deferredSend.promise);
    await act(async () => changeAssistantDraft(container, "old Workspace question"));
    const sendButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Send"));
    expect(sendButton).toBeTruthy();
    await act(async () => sendButton?.click());
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => sendButton?.click());
    expect(marketplace.sendAssistantMessage).toHaveBeenCalledTimes(1);

    await renderWorkspace(root, queryClient, "workspace-3");
    await waitForText(container, "Choose an Agent");
    deferredSend.resolve({ run: { id: "old-send-run" } });
    await act(async () => deferredSend.promise);
    await flushReact();
    expect(container.querySelector('[aria-label="Assistant transcript"]')).toBeNull();
    expect(container.querySelector('[aria-label="New conversation"]')).toBeNull();

    await openAssistantSession(container);
    const deferredClose = deferred<{ session: { id: string; status: string } }>();
    marketplace.closeAssistantSession.mockReturnValueOnce(deferredClose.promise);
    const newConversationButton = container.querySelector<HTMLButtonElement>('[aria-label="New conversation"]');
    expect(newConversationButton).not.toBeNull();
    await act(async () => newConversationButton?.click());
    expect(newConversationButton?.disabled).toBe(true);
    await act(async () => newConversationButton?.click());
    expect(marketplace.closeAssistantSession).toHaveBeenCalledTimes(1);

    await renderWorkspace(root, queryClient, "workspace-4");
    await waitForText(container, "Choose an Agent");
    deferredClose.resolve({ session: { id: "session-1", status: "closed" } });
    await act(async () => deferredClose.promise);
    await flushReact();
    expect(container.querySelector('[aria-label="Assistant transcript"]')).toBeNull();
    expect(container.querySelector('[aria-label="New conversation"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("locks duplicate sends and keeps the draft when the send request fails", async () => {
    const deferredSend = deferred<never>();
    marketplace.sendAssistantMessage.mockReturnValueOnce(deferredSend.promise);
    const { root } = await renderPanel(container);
    await openAssistantSession(container);

    await act(async () => changeAssistantDraft(container, "Keep this draft"));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Assistant message']");
    const sendButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Send"));
    await act(async () => sendButton?.click());
    expect(textarea?.disabled).toBe(true);
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => sendButton?.click());
    expect(marketplace.sendAssistantMessage).toHaveBeenCalledTimes(1);

    deferredSend.reject(new Error("Assistant is unavailable."));
    await act(async () => deferredSend.promise.catch(() => undefined));
    await flushReact();
    expect(textarea?.value).toBe("Keep this draft");
    expect(container.textContent).toContain("Assistant is unavailable.");
    expect(textarea?.disabled).toBe(false);
    await act(async () => root.unmount());
  });
});
