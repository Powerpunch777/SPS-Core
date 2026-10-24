import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { spsExecutionsApi } from "./sps-executions";

describe("spsExecutionsApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("requests only the bounded Plugin summary and forwards the abort signal", async () => {
    const controller = new AbortController();
    mockApi.get.mockResolvedValue({});

    await spsExecutionsApi.summary("company-1", "plugin-1", {
      from: "2026-10-23T00:00:00.000Z",
      to: "2026-10-24T00:00:00.000Z",
      signal: controller.signal,
    });

    const [path, options] = mockApi.get.mock.calls[0] as [string, { signal: AbortSignal }];
    const parsed = new URL(path, "http://localhost");
    expect(parsed.pathname).toBe("/companies/company-1/sps-executions/summary");
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({
      pluginId: "plugin-1",
      from: "2026-10-23T00:00:00.000Z",
      to: "2026-10-24T00:00:00.000Z",
    });
    expect(options.signal).toBe(controller.signal);
  });

  it("lists one bounded page with an optional lane and the complete cursor trio", async () => {
    const controller = new AbortController();
    mockApi.get.mockResolvedValue({ items: [], nextCursor: null });

    await spsExecutionsApi.list("company-1", "plugin-1", {
      lane: "agent_session",
      cursor: {
        createdAt: "2026-10-23T10:20:30.123Z",
        runId: "00000000-0000-4000-8000-000000000001",
        lane: "node",
      },
      signal: controller.signal,
    });

    const [path, options] = mockApi.get.mock.calls[0] as [string, { signal: AbortSignal }];
    const parsed = new URL(path, "http://localhost");
    expect(parsed.pathname).toBe("/companies/company-1/sps-executions");
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({
      pluginId: "plugin-1",
      limit: "20",
      lane: "agent_session",
      beforeCreatedAt: "2026-10-23T10:20:30.123Z",
      beforeRunId: "00000000-0000-4000-8000-000000000001",
      beforeLane: "node",
    });
    expect(options.signal).toBe(controller.signal);
  });

  it("omits the lane and cursor for the first all-lanes page", async () => {
    mockApi.get.mockResolvedValue({ items: [], nextCursor: null });

    await spsExecutionsApi.list("company-1", "plugin-1", {});

    const [path] = mockApi.get.mock.calls[0] as [string];
    const parsed = new URL(path, "http://localhost");
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({ pluginId: "plugin-1", limit: "20" });
  });

  it("gets a safe execution detail with the selected plugin scope and abort signal", async () => {
    const controller = new AbortController();
    mockApi.get.mockResolvedValue(null);

    await spsExecutionsApi.get(
      "company-1",
      "plugin-1",
      "node",
      "00000000-0000-4000-8000-000000000001",
      { signal: controller.signal },
    );

    const [path, options] = mockApi.get.mock.calls[0] as [string, { signal: AbortSignal }];
    const parsed = new URL(path, "http://localhost");
    expect(parsed.pathname).toBe("/companies/company-1/sps-executions/node/00000000-0000-4000-8000-000000000001");
    expect(Object.fromEntries(parsed.searchParams.entries())).toEqual({ pluginId: "plugin-1" });
    expect(options.signal).toBe(controller.signal);
  });
});
