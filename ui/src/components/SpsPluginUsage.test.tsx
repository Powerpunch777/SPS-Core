// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSpsExecutionSummary, PluginSpsUsageAggregateMetric } from "@/compat/paperclip/plugin-sdk";
import { ApiError } from "@/api/client";

const mockSpsExecutionsApi = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("@/api/sps-executions", () => ({
  spsExecutionsApi: mockSpsExecutionsApi,
}));

import { SpsPluginUsage } from "./SpsPluginUsage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 24 * 60 * 60 * 1000;

function aggregate(overrides: Partial<PluginSpsUsageAggregateMetric> = {}): PluginSpsUsageAggregateMetric {
  return {
    reported: null,
    estimated: null,
    reportedExecutions: 0,
    estimatedExecutions: 0,
    unavailableExecutions: 0,
    overflowed: false,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PluginSpsExecutionSummary> = {}): PluginSpsExecutionSummary {
  const base: PluginSpsExecutionSummary = {
    companyId: "company-1",
    pluginKey: "example.plugin",
    window: { from: "2026-10-23T00:00:00.000Z", to: "2026-10-24T00:00:00.000Z" },
    generatedAt: "2026-10-24T00:00:00.000Z",
    executionCount: 3,
    terminalCount: 2,
    inFlightCount: 1,
    unknownPhaseCount: 0,
    tokens: {
      inputTokens: aggregate({ reported: 120, reportedExecutions: 2, unavailableExecutions: 1 }),
      cachedInputTokens: aggregate({ estimated: 24, estimatedExecutions: 1, unavailableExecutions: 2 }),
      outputTokens: aggregate({ reported: 18, reportedExecutions: 1, unavailableExecutions: 2 }),
    },
    costs: {
      currency: "USD",
      incrementalApi: aggregate({ reported: 0.0125, reportedExecutions: 1, unavailableExecutions: 2 }),
      subscriptionReference: aggregate({ reported: 0.25, reportedExecutions: 1, unavailableExecutions: 2 }),
      other: aggregate({ unavailableExecutions: 3 }),
    },
    duration: { totalMs: 4200, knownExecutions: 2, unavailableExecutions: 1, overflowed: false },
  };
  return {
    ...base,
    ...overrides,
    window: { ...base.window, ...overrides.window },
    tokens: { ...base.tokens, ...overrides.tokens },
    costs: { ...base.costs, ...overrides.costs },
    duration: { ...base.duration, ...overrides.duration },
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("SpsPluginUsage", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let queryClient: QueryClient;

  async function renderUsage(companyId = "company-1", pluginId = "plugin-1") {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginUsage companyId={companyId} pluginId={pluginId} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockSpsExecutionsApi.summary.mockResolvedValue(makeSummary());
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    queryClient?.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads a bounded UTC window, keeps it stable, and refreshes it only on request", async () => {
    const initialEnd = Date.parse("2026-10-24T12:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(initialEnd);
    await renderUsage();

    const period = container.querySelector("select[aria-label='Usage time window']") as HTMLSelectElement;
    expect(Array.from(period.options).map((option) => option.value)).toEqual(["24h", "7d", "30d"]);
    expect(mockSpsExecutionsApi.summary).toHaveBeenCalledTimes(1);
    const firstWindow = mockSpsExecutionsApi.summary.mock.calls[0][2];
    expect(Date.parse(firstWindow.to) - Date.parse(firstWindow.from)).toBe(DAY_MS);
    expect(firstWindow.from).toBe(new Date(initialEnd - DAY_MS).toISOString());

    now.mockReturnValue(initialEnd + 30 * DAY_MS);
    expect(container.textContent).toContain(firstWindow.to);
    expect(mockSpsExecutionsApi.summary).toHaveBeenCalledTimes(1);

    await act(async () => {
      period.value = "30d";
      period.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    const monthWindow = mockSpsExecutionsApi.summary.mock.calls.at(-1)?.[2];
    expect(Date.parse(monthWindow.to) - Date.parse(monthWindow.from)).toBe(30 * DAY_MS);
    expect(Date.parse(monthWindow.to) - Date.parse(monthWindow.from)).toBeLessThanOrEqual(31 * DAY_MS);

    const refresh = container.querySelector("button[aria-label='Refresh execution usage']") as HTMLButtonElement;
    await act(async () => refresh.click());
    await flushReact();
    const refreshedWindow = mockSpsExecutionsApi.summary.mock.calls.at(-1)?.[2];
    expect(refreshedWindow.to).toBe(new Date(initialEnd + 30 * DAY_MS).toISOString());
    expect(refreshedWindow.from).toBe(new Date(initialEnd).toISOString());
  });

  it("shows a loading state and disables refresh while the summary is pending", async () => {
    let resolveSummary!: (value: PluginSpsExecutionSummary) => void;
    mockSpsExecutionsApi.summary.mockReturnValueOnce(
      new Promise<PluginSpsExecutionSummary>((resolve) => { resolveSummary = resolve; }),
    );
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginUsage companyId="company-1" pluginId="plugin-1" />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Loading execution usage...");
    expect((container.querySelector("button[aria-label='Refresh execution usage']") as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolveSummary(makeSummary()));
    await flushReact();
    expect(container.textContent).toContain("Executions");
  });

  it("never carries totals across a workspace/plugin scope switch or a failed new request", async () => {
    let rejectSecond!: (error: Error) => void;
    mockSpsExecutionsApi.summary
      .mockResolvedValueOnce(makeSummary({ executionCount: 7 }))
      .mockReturnValueOnce(new Promise<PluginSpsExecutionSummary>((_resolve, reject) => { rejectSecond = reject; }));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginUsage key="company-1:plugin-1" companyId="company-1" pluginId="plugin-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const executionCount = () => {
      const label = Array.from(container.querySelectorAll("dt")).find((item) => item.textContent === "Executions");
      return label?.nextElementSibling?.textContent;
    };
    expect(executionCount()).toBe("7");

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SpsPluginUsage key="company-2:plugin-2" companyId="company-2" pluginId="plugin-2" />
        </QueryClientProvider>,
      );
    });
    expect(container.textContent).toContain("Loading execution usage...");
    expect(executionCount()).toBeUndefined();

    await act(async () => rejectSecond(new ApiError("private details", 500, { error: "private details" })));
    await flushReact();
    expect(container.textContent).toContain("Execution usage could not be loaded.");
    expect(container.textContent).not.toContain("private details");
    expect(executionCount()).toBeUndefined();
    expect(mockSpsExecutionsApi.summary).toHaveBeenLastCalledWith(
      "company-2",
      "plugin-2",
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });

  it("keeps 403 host-only copy plain and does not automatically retry", async () => {
    mockSpsExecutionsApi.summary.mockRejectedValueOnce(new ApiError("sensitive host detail", 403, { error: "sensitive host detail" }));
    await renderUsage();

    expect(container.textContent).toContain("Only the local Host can view execution usage.");
    expect(container.textContent).not.toContain("sensitive host detail");
    expect(container.querySelector("button")?.textContent).not.toContain("Retry");
    expect(mockSpsExecutionsApi.summary).toHaveBeenCalledTimes(1);

    mockSpsExecutionsApi.summary.mockResolvedValueOnce(makeSummary());
    await act(async () => {
      (container.querySelector("button[aria-label='Refresh execution usage']") as HTMLButtonElement).click();
    });
    await flushReact();
    expect(mockSpsExecutionsApi.summary).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Executions");
  });

  it("offers manual retry for transient errors and guides 422 users to a shorter window", async () => {
    mockSpsExecutionsApi.summary
      .mockRejectedValueOnce(new ApiError("temporary failure", 500, { error: "temporary failure" }))
      .mockResolvedValueOnce(makeSummary())
      .mockRejectedValueOnce(new ApiError("too many matches", 422, { error: "too many matches" }))
      .mockResolvedValueOnce(makeSummary());
    await renderUsage();

    expect(container.textContent).toContain("Execution usage could not be loaded.");
    expect(container.textContent).not.toContain("temporary failure");
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
    expect(retry).toBeTruthy();
    await act(async () => retry?.click());
    await flushReact();
    expect(container.textContent).toContain("Executions");

    const period = container.querySelector("select[aria-label='Usage time window']") as HTMLSelectElement;
    await act(async () => {
      period.value = "30d";
      period.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Too many executions. Select a shorter time window.");
    expect(container.textContent).not.toContain("too many matches");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Retry")).toBe(false);

    await act(async () => {
      period.value = "7d";
      period.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    expect(mockSpsExecutionsApi.summary).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain("Executions");
  });

  it("preserves explicit zero, distinguishes unknowns, and labels overflow safely", async () => {
    mockSpsExecutionsApi.summary.mockResolvedValueOnce(makeSummary({
      executionCount: 3,
      tokens: {
        inputTokens: aggregate({ reported: 0, reportedExecutions: 1, unavailableExecutions: 2 }),
        cachedInputTokens: aggregate({ unavailableExecutions: 3 }),
        outputTokens: aggregate({ unavailableExecutions: 3, overflowed: true }),
      },
      costs: {
        currency: "USD",
        incrementalApi: aggregate({ reported: 0, reportedExecutions: 1, unavailableExecutions: 2 }),
        subscriptionReference: aggregate({ reported: 1e-13, reportedExecutions: 1, unavailableExecutions: 2 }),
        other: aggregate({ unavailableExecutions: 3, overflowed: true }),
      },
    }));
    await renderUsage();

    const row = (label: string) => Array.from(container.querySelectorAll("tbody tr"))
      .find((item) => item.querySelector("th")?.textContent === label);
    const cells = (label: string) => {
      const rowCells = row(label)?.querySelectorAll("td");
      const amountAndCoverage = (cell?: Element) => [
        cell?.querySelector('[data-testid="aggregate-value"]')?.textContent,
        cell?.querySelector('[data-testid="aggregate-coverage"]')?.textContent,
      ];
      return {
        reported: amountAndCoverage(rowCells?.[0]),
        estimated: amountAndCoverage(rowCells?.[1]),
        unavailable: rowCells?.[2]?.textContent,
      };
    };
    const tables = Array.from(container.querySelectorAll("table"));
    expect(tables.map((table) => table.querySelectorAll("thead th").length)).toEqual([4, 4]);
    expect(tables.every((table) => table.classList.contains("table-fixed"))).toBe(true);
    expect(container.querySelector(".overflow-x-auto")).toBeNull();
    expect(cells("Input tokens")).toEqual({
      reported: ["0", "1 executions"],
      estimated: ["Unavailable", "0 executions"],
      unavailable: "2",
    });
    expect(cells("Cached input tokens")).toEqual({
      reported: ["Unavailable", "0 executions"],
      estimated: ["Unavailable", "0 executions"],
      unavailable: "3",
    });
    expect(cells("Output tokens")).toEqual({
      reported: ["Unknown (overflow)", "0 executions"],
      estimated: ["Unknown (overflow)", "0 executions"],
      unavailable: "3",
    });
    expect(cells("Incremental API")).toEqual({
      reported: ["$0", "1 executions"],
      estimated: ["Unavailable", "0 executions"],
      unavailable: "2",
    });
    expect(cells("Subscription reference").reported[0]).toBe("<$0.000000000001");
    expect(cells("Other")).toEqual({
      reported: ["Unknown (overflow)", "0 executions"],
      estimated: ["Unknown (overflow)", "0 executions"],
      unavailable: "3",
    });
    expect(container.textContent).toContain("not an invoice");
    expect(container.textContent).toContain("Unavailable means no aggregate value was available; it is not zero.");
    expect(container.textContent).not.toContain("Grand total");
  });
});
