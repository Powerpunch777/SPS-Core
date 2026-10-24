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
});
