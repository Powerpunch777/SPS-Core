// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import type { PluginSpsExecution, PluginSpsExecutionPage } from "@/api/sps-executions";

const mockSpsExecutionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/api/sps-executions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/sps-executions")>();
  return { ...original, spsExecutionsApi: mockSpsExecutionsApi };
});

import { SpsPluginExecutions } from "./SpsPluginExecutions";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RUN_ONE = "11111111-1111-4111-8111-111111111111";
const RUN_TWO = "22222222-2222-4222-8222-222222222222";
const RUN_THREE = "33333333-3333-4333-8333-333333333333";
const PRIVATE_MARKERS = [
  "private.plugin.label",
  "private subject value",
  "private session value",
  "private agent value",
  "private failure code",
];

type ExecutionOverrides = Partial<Omit<PluginSpsExecution, "runtime" | "usage">> & {
  runtime?: Partial<PluginSpsExecution["runtime"]>;
  usage?: Partial<PluginSpsExecution["usage"]>;
};

function makeExecution(runId = RUN_ONE, overrides: ExecutionOverrides = {}): PluginSpsExecution {
  const base: PluginSpsExecution = {
    lane: "node",
    runId,
    companyId: "company-1",
    pluginKey: PRIVATE_MARKERS[0],
    agentId: PRIVATE_MARKERS[3],
    sessionId: PRIVATE_MARKERS[2],
    subjectKey: PRIVATE_MARKERS[1],
    runtime: { kind: "process", model: null, modelSource: "unavailable" },
    status: "failed",
    phase: "failed",
    cancellationRequested: true,
    termination: "pending",
    failure: { category: "execution", code: PRIVATE_MARKERS[4], retrySafety: "requires_review" },
    createdAt: "2026-10-24T10:00:00.000Z",
    startedAt: "2026-10-24T10:00:01.000Z",
    finishedAt: "2026-10-24T10:00:03.500Z",
    elapsedMs: 2500,
    usage: {
      inputTokens: { value: 0, provenance: "reported" },
      cachedInputTokens: { value: null, provenance: "unavailable" },
      outputTokens: { value: 7, provenance: "estimated" },
      costUsd: { value: 1e-9, provenance: "reported" },
      currency: "USD",
      billingType: "metered_api",
      costBasis: "incremental_api",
    },
  };
  const usage = { ...base.usage, ...overrides.usage };
  return {
    ...base,
    ...overrides,
    runtime: { ...base.runtime, ...overrides.runtime },
    usage: {
      ...usage,
      inputTokens: { ...base.usage.inputTokens, ...overrides.usage?.inputTokens },
      cachedInputTokens: { ...base.usage.cachedInputTokens, ...overrides.usage?.cachedInputTokens },
      outputTokens: { ...base.usage.outputTokens, ...overrides.usage?.outputTokens },
      costUsd: { ...base.usage.costUsd, ...overrides.usage?.costUsd },
    },
  };
}

function makePage(items: PluginSpsExecution[], nextCursor: PluginSpsExecutionPage["nextCursor"] = null): PluginSpsExecutionPage {
  return { items, nextCursor };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsPluginExecutions", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let queryClient: QueryClient;

  async function render(companyId = "company-1", pluginId = "plugin-1") {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginExecutions companyId={companyId} pluginId={pluginId} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSpsExecutionsApi.list.mockResolvedValue(makePage([makeExecution()]));
    mockSpsExecutionsApi.get.mockResolvedValue(makeExecution());
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    queryClient?.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("loads a bounded list, exposes the stable controls, and refreshes only on request", async () => {
    let resolveList!: (page: PluginSpsExecutionPage) => void;
    mockSpsExecutionsApi.list.mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve; }));
    await render();

    expect(container.querySelector('[data-testid="sps-plugin-executions"]')).toBeTruthy();
    expect(container.textContent).toContain("Loading execution history...");
    const lane = container.querySelector('select[aria-label="Execution lane"]') as HTMLSelectElement;
    expect(Array.from(lane.options).map((option) => option.value)).toEqual(["all", "agent_session", "node", "model_request"]);
    const refresh = container.querySelector('button[aria-label="Refresh execution history"]') as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(mockSpsExecutionsApi.list).toHaveBeenCalledWith(
      "company-1",
      "plugin-1",
      expect.objectContaining({ limit: 20, cursor: null, signal: expect.any(AbortSignal) }),
    );

    await act(async () => resolveList(makePage([makeExecution()])));
    await flushReact();
    expect(container.textContent).toContain(RUN_ONE);
    expect(refresh.disabled).toBe(false);

    await act(async () => refresh.click());
    await flushReact();
    expect(mockSpsExecutionsApi.list).toHaveBeenCalledTimes(2);
    expect(mockSpsExecutionsApi.list).toHaveBeenLastCalledWith(
      "company-1",
      "plugin-1",
      expect.objectContaining({ limit: 20, cursor: null }),
    );
  });

  it("renders only safe projections, distinguishes zero from unknown, and loads details explicitly", async () => {
    mockSpsExecutionsApi.list.mockResolvedValue(makePage([
      makeExecution(RUN_ONE),
      makeExecution(RUN_TWO, { runtime: { kind: "claude_local" } }),
      makeExecution(RUN_THREE, { runtime: { kind: "codex_local" } }),
      makeExecution("44444444-4444-4444-8444-444444444444", { runtime: { kind: "unrecognized-private-runtime" } }),
    ]));
    await render();

    expect(container.textContent).toContain("Local process");
    expect(container.textContent).toContain("Claude CLI");
    expect(container.textContent).toContain("Codex CLI");
    expect(container.textContent).toContain("Unknown runtime");
    expect(container.textContent).not.toContain("unrecognized-private-runtime");
    for (const marker of PRIVATE_MARKERS) expect(container.textContent).not.toContain(marker);

    const details = container.querySelector(`button[aria-label="View execution ${RUN_ONE}"]`) as HTMLButtonElement;
    await act(async () => details.click());
    await flushReact();

    expect(mockSpsExecutionsApi.get).toHaveBeenCalledWith(
      "company-1",
      "plugin-1",
      "node",
      RUN_ONE,
      { signal: expect.any(AbortSignal) },
    );
    const detail = container.querySelector('[data-testid="sps-execution-detail"]');
    expect(detail?.textContent).toContain("0 · Reported");
    expect(detail?.textContent).toContain("Unknown");
    expect(detail?.textContent).toContain("<$0.00000001");
    expect(detail?.textContent).toContain("Incremental API");
    expect(detail?.textContent).toContain("Requires review");
    expect(detail?.textContent).toContain("Pending");
    for (const marker of PRIVATE_MARKERS) expect(detail?.textContent).not.toContain(marker);

    const close = container.querySelector(`button[aria-label="Close execution ${RUN_ONE}"]`) as HTMLButtonElement;
    await act(async () => close.click());
    expect(container.querySelector('[data-testid="sps-execution-detail"]')).toBeNull();
  });

  it("labels the model lane and its configured model without claiming provider identity", async () => {
    const execution = makeExecution(RUN_ONE, { lane: "model_request", runtime: { kind: "model_api", model: "mock-model", modelSource: "configured" },
      status: "succeeded", phase: "succeeded", cancellationRequested: false, termination: "not_applicable", failure: null });
    mockSpsExecutionsApi.list.mockResolvedValue(makePage([execution]));
    mockSpsExecutionsApi.get.mockResolvedValue(execution);
    await render();
    expect(container.textContent).toContain("Model request");
    expect(container.textContent).toContain("Model API");
    await act(async () => (container.querySelector(`button[aria-label="View execution ${RUN_ONE}"]`) as HTMLButtonElement).click());
    await flushReact();
    const detail = container.querySelector('[data-testid="sps-execution-detail"]');
    expect(detail?.textContent).toContain("mock-model");
    expect(detail?.textContent).toContain("Host configured");
    expect(detail?.textContent).not.toContain("Provider or adapter report");
    expect(mockSpsExecutionsApi.get).toHaveBeenCalledWith("company-1", "plugin-1", "model_request", RUN_ONE, { signal: expect.any(AbortSignal) });
  });

  it("shows empty state with usable paging controls and applies lane, older, newer, and refresh resets", async () => {
    const olderCursor = { createdAt: "2026-10-23T10:00:00.000Z", runId: RUN_ONE, lane: "node" as const };
    const agentCursor = { createdAt: "2026-10-22T10:00:00.000Z", runId: RUN_TWO, lane: "agent_session" as const };
    mockSpsExecutionsApi.list.mockImplementation((_companyId, _pluginId, options) => {
      if (options?.lane === "agent_session" && options.cursor) return Promise.resolve(makePage([], null));
      if (options?.lane === "agent_session") return Promise.resolve(makePage([makeExecution(RUN_TWO, { lane: "agent_session" })], agentCursor));
      if (options?.cursor) return Promise.resolve(makePage([makeExecution(RUN_THREE)], null));
      return Promise.resolve(makePage([makeExecution()], olderCursor));
    });
    await render();

    const buttons = () => Array.from(container.querySelectorAll("button"));
    const older = () => buttons().find((button) => button.textContent?.includes("Older")) as HTMLButtonElement;
    const newer = () => buttons().find((button) => button.textContent?.includes("Newer")) as HTMLButtonElement;
    expect(older().disabled).toBe(false);
    await act(async () => older().click());
    await flushReact();
    expect(container.textContent).toContain(RUN_THREE);
    expect(mockSpsExecutionsApi.list).toHaveBeenLastCalledWith(
      "company-1", "plugin-1", expect.objectContaining({ cursor: olderCursor, limit: 20 }),
    );
    expect(newer().disabled).toBe(false);
    await act(async () => newer().click());
    await flushReact();
    expect(container.textContent).toContain(RUN_ONE);

    const lane = container.querySelector('select[aria-label="Execution lane"]') as HTMLSelectElement;
    await act(async () => {
      lane.value = "agent_session";
      lane.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain(RUN_TWO);
    expect(mockSpsExecutionsApi.list).toHaveBeenLastCalledWith(
      "company-1", "plugin-1", expect.objectContaining({ lane: "agent_session", cursor: null }),
    );

    await act(async () => older().click());
    await flushReact();
    expect(container.textContent).toContain("No executions.");
    expect(newer().disabled).toBe(false);
    await act(async () => newer().click());
    await flushReact();
    expect(container.textContent).toContain(RUN_TWO);

    await act(async () => older().click());
    await flushReact();
    await act(async () => (container.querySelector('button[aria-label="Refresh execution history"]') as HTMLButtonElement).click());
    await flushReact();
    expect(container.textContent).toContain(RUN_TWO);
    expect(mockSpsExecutionsApi.list).toHaveBeenLastCalledWith(
      "company-1", "plugin-1", expect.objectContaining({ lane: "agent_session", cursor: null }),
    );
  });

  it.each([
    [403, "Only the local Host can view execution history."],
    [500, "Execution history could not be loaded."],
  ])("keeps list errors safe for status %s", async (status, safeMessage) => {
    mockSpsExecutionsApi.list.mockRejectedValueOnce(new ApiError("private backend error", status, { error: "private backend error" }));
    await render();

    expect(container.textContent).toContain(safeMessage);
    expect(container.textContent).not.toContain("private backend error");
    expect(mockSpsExecutionsApi.list).toHaveBeenCalledTimes(1);
  });

  it("does not show a prior scope's rows during or after a failed scope switch", async () => {
    let rejectSecond!: (error: Error) => void;
    mockSpsExecutionsApi.list
      .mockResolvedValueOnce(makePage([makeExecution(RUN_ONE)]))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSecond = reject; }));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginExecutions key="company-1:plugin-1" companyId="company-1" pluginId="plugin-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    expect(container.textContent).toContain(RUN_ONE);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginExecutions key="company-2:plugin-2" companyId="company-2" pluginId="plugin-2" />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toContain("Loading execution history...");
    expect(container.textContent).not.toContain(RUN_ONE);

    await act(async () => rejectSecond(new ApiError("private backend error", 500, { error: "private backend error" })));
    await flushReact();
    expect(container.textContent).toContain("Execution history could not be loaded.");
    expect(container.textContent).not.toContain(RUN_ONE);
    expect(container.textContent).not.toContain("private backend error");
    expect(mockSpsExecutionsApi.list).toHaveBeenLastCalledWith(
      "company-2", "plugin-2", expect.objectContaining({ limit: 20 }),
    );
  });

  it("keeps detail authorization and generic failures safe", async () => {
    mockSpsExecutionsApi.get.mockRejectedValueOnce(new ApiError("private detail error", 403, { error: "private detail error" }));
    await render();

    await act(async () => {
      (container.querySelector(`button[aria-label="View execution ${RUN_ONE}"]`) as HTMLButtonElement).click();
    });
    await flushReact();
    expect(container.textContent).toContain("Only the local Host can view execution details.");
    expect(container.textContent).not.toContain("private detail error");
    expect(mockSpsExecutionsApi.get).toHaveBeenCalledTimes(1);
  });
});
