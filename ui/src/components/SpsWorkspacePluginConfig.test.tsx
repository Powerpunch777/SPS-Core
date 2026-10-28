// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { SpsWorkspacePluginConfig } from "./SpsWorkspacePluginConfig";

const mockConfigApi = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/api/sps-workspace-plugin-config", () => ({
  spsWorkspacePluginConfigApi: mockConfigApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createPlugin(workspaceWorker: boolean): PluginRecord {
  return {
    id: "plugin-1",
    manifestJson: {
      entrypoints: workspaceWorker ? { workspaceWorker: "workspace-worker.mjs" } : {},
      workspaceConfigSchema: {
        type: "object",
        properties: { label: { type: "string" } },
      },
    },
  } as unknown as PluginRecord;
}

function configRecord(workspaceId: string, configJson: Record<string, unknown> = {}, revision: string | null = null) {
  return { workspaceId, pluginId: "plugin-1", configJson, revision, updatedAt: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function until(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("SpsWorkspacePluginConfig", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function render(workspaceId: string, workspaceWorker = true) {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SpsWorkspacePluginConfig plugin={createPlugin(workspaceWorker)} workspaceId={workspaceId} />
      </QueryClientProvider>,
    );
  }

  it("does not query or render when the manifest has no workspace worker", async () => {
    render("workspace-1", false);
    await flushReact();
    expect(container.textContent).toBe("");
    expect(mockConfigApi.get).not.toHaveBeenCalled();
  });

  it("renders empty defaults and sends an explicit save with the observed revision", async () => {
    mockConfigApi.get.mockResolvedValue(configRecord("workspace-1"));
    mockConfigApi.put.mockResolvedValue(configRecord("workspace-1", { label: "new label" }, "revision-2"));
    render("workspace-1");

    await until(() => expect(container.querySelector("input")).not.toBeNull());
    const input = container.querySelector("input")!;
    expect(input.value).toBe("");

    await act(async () => {
      setInputValue(input, "new label");
    });
    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!;
    expect(saveButton.disabled).toBe(false);

    await act(async () => saveButton.click());
    expect(mockConfigApi.put).toHaveBeenCalledWith("plugin-1", "workspace-1", {
      configJson: { label: "new label" },
      expectedRevision: null,
    });
  });

  it("keeps a dirty draft scoped to its workspace after switching targets", async () => {
    mockConfigApi.get.mockImplementation(async (_pluginId: string, workspaceId: string) =>
      workspaceId === "workspace-1"
        ? configRecord(workspaceId, { label: "first workspace" }, "revision-1")
        : configRecord(workspaceId, { label: "second workspace" }, "revision-2"));
    render("workspace-1");
    await until(() => expect(container.querySelector("input")?.value).toBe("first workspace"));

    const firstInput = container.querySelector("input")!;
    await act(async () => {
      setInputValue(firstInput, "private draft");
    });
    render("workspace-2");
    await until(() => expect(container.querySelector("input")?.value).toBe("second workspace"));
    expect(container.textContent).not.toContain("private draft");
    expect(mockConfigApi.put).not.toHaveBeenCalled();
  });

  it("does not let a pending old-target GET retarget the newly selected workspace", async () => {
    const oldWorkspaceRequest = deferred<ReturnType<typeof configRecord>>();
    let firstWorkspaceReads = 0;
    mockConfigApi.get.mockImplementation(async (_pluginId: string, workspaceId: string) => {
      if (workspaceId === "workspace-1") {
        firstWorkspaceReads += 1;
        return firstWorkspaceReads === 1
          ? oldWorkspaceRequest.promise
          : configRecord(workspaceId, { label: "fresh first workspace" }, "revision-1-fresh");
      }
      return configRecord(workspaceId, { label: "second workspace" }, "revision-2");
    });

    render("workspace-1");
    await until(() => expect(mockConfigApi.get).toHaveBeenCalledWith("plugin-1", "workspace-1", expect.any(Object)));
    render("workspace-2");
    await until(() => expect(container.querySelector("input")?.value).toBe("second workspace"));
    oldWorkspaceRequest.resolve(configRecord("workspace-1", { label: "stale first workspace" }, "revision-1-stale"));
    await flushReact();
    expect(container.querySelector("input")?.value).toBe("second workspace");

    render("workspace-1");
    await until(() => expect(container.querySelector("input")?.value).toBe("fresh first workspace"));
    expect(firstWorkspaceReads).toBeGreaterThanOrEqual(2);
  });

  it("ignores a save response after A-to-B-to-A and refreshes the current target", async () => {
    const oldSave = deferred<ReturnType<typeof configRecord>>();
    let firstWorkspaceReads = 0;
    mockConfigApi.get.mockImplementation(async (_pluginId: string, workspaceId: string) => {
      if (workspaceId === "workspace-1") {
        firstWorkspaceReads += 1;
        return configRecord(workspaceId, { label: firstWorkspaceReads === 1 ? "first workspace" : "fresh first workspace" },
          firstWorkspaceReads === 1 ? "revision-1" : "revision-1-fresh");
      }
      return configRecord(workspaceId, { label: "second workspace" }, "revision-2");
    });
    mockConfigApi.put.mockReturnValue(oldSave.promise);

    render("workspace-1");
    await until(() => expect(container.querySelector("input")?.value).toBe("first workspace"));
    await act(async () => setInputValue(container.querySelector("input")!, "old draft"));
    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!;
    await act(async () => saveButton.click());
    await until(() => expect(mockConfigApi.put).toHaveBeenCalledTimes(1));

    render("workspace-2");
    await until(() => expect(container.querySelector("input")?.value).toBe("second workspace"));
    render("workspace-1");
    await until(() => expect(container.querySelector("input")?.value).toBe("fresh first workspace"));

    oldSave.resolve(configRecord("workspace-1", { label: "stale save response" }, "revision-1-stale-save"));
    await until(() => expect(container.querySelector("input")?.value).toBe("fresh first workspace"));
    expect(mockConfigApi.put).toHaveBeenCalledTimes(1);
    expect(mockConfigApi.get).toHaveBeenCalledWith("plugin-1", "workspace-1", expect.any(Object));
  });

  it("preserves a conflicted draft but requires an explicit reload before another write", async () => {
    let reads = 0;
    mockConfigApi.get.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? configRecord("workspace-1", { label: "server value" }, "revision-1")
        : configRecord("workspace-1", { label: "newer server value" }, "revision-2");
    });
    mockConfigApi.put.mockRejectedValue(new ApiError("private conflict payload", 409, { error: "private conflict payload" }));
    render("workspace-1");
    await until(() => expect(container.querySelector("input")?.value).toBe("server value"));
    await act(async () => setInputValue(container.querySelector("input")!, "my draft"));
    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!;
    await act(async () => saveButton.click());

    await until(() => expect(container.textContent).toContain("Your draft is preserved"));
    expect(container.querySelector("input")?.value).toBe("my draft");
    expect(container.textContent).not.toContain("private conflict payload");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")?.disabled).toBe(true);
    expect(mockConfigApi.put).toHaveBeenCalledTimes(1);

    const reloadButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Reload workspace configuration")!;
    await act(async () => reloadButton.click());
    await until(() => expect(container.querySelector("input")?.value).toBe("newer server value"));
    expect(container.textContent).toContain("The previous draft was discarded");
    expect(mockConfigApi.put).toHaveBeenCalledTimes(1);
  });

  it("shows a fixed Host-only explanation and disables writes on a 403", async () => {
    mockConfigApi.get.mockRejectedValue(new ApiError("sensitive backend details", 403, { error: "sensitive backend details" }));
    render("workspace-1");
    await until(() => expect(container.textContent).toContain("available only from the SPS Host"));
    expect(container.textContent).not.toContain("sensitive backend details");
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });
});
