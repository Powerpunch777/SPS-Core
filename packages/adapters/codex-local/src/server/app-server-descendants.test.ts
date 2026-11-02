import { describe, expect, it, vi } from "vitest";
import { readCodexDirectChildren, type AppServerReadRequest } from "./app-server-descendants.js";

const parentId = "123e4567-e89b-42d3-a456-426614174000";
const childId = "223e4567-e89b-42d3-a456-426614174000";
const secondChildId = "323e4567-e89b-42d3-a456-426614174000";

function thread(id: string, parentThreadId = parentId, extra: Record<string, unknown> = {}) {
  return { id, parentThreadId, agentRole: "worker", agentNickname: "Scout", status: "running", ...extra };
}

describe("readCodexDirectChildren", () => {
  it("reads all pages and returns only the selected child metadata", async () => {
    const request = vi.fn<AppServerReadRequest>()
      .mockResolvedValueOnce({ data: [thread(childId)], nextCursor: "page-2", ignored: true })
      .mockResolvedValueOnce({ data: [thread(secondChildId, parentId, { agentNickname: null })], nextCursor: null });

    const result = await readCodexDirectChildren(request, parentId, { pageSize: 1 });

    expect(request).toHaveBeenNthCalledWith(1, "thread/list", {
      parentThreadId: parentId, limit: 1, cursor: null, archived: false,
    });
    expect(request).toHaveBeenNthCalledWith(2, "thread/list", {
      parentThreadId: parentId, limit: 1, cursor: "page-2", archived: false,
    });
    expect(result).toEqual({ children: [
      { id: childId, parentThreadId: parentId, agentRole: "worker", agentNickname: "Scout" },
      { id: secondChildId, parentThreadId: parentId, agentRole: "worker", agentNickname: null },
    ] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.children)).toBe(true);
    expect(Object.isFrozen(result.children[0])).toBe(true);
  });

  it("fails closed when an entry is missing its parent or has another parent", async () => {
    for (const entry of [
      { id: childId },
      thread(childId, secondChildId),
    ]) {
      const request = vi.fn<AppServerReadRequest>().mockResolvedValue({ data: [entry], nextCursor: null });
      await expect(readCodexDirectChildren(request, parentId)).rejects.toThrow(/parentThreadId/);
    }
  });

  it("rejects duplicate IDs across pages and self references", async () => {
    const duplicate = vi.fn<AppServerReadRequest>()
      .mockResolvedValueOnce({ data: [thread(childId)], nextCursor: "next" })
      .mockResolvedValueOnce({ data: [thread(childId)], nextCursor: null });
    await expect(readCodexDirectChildren(duplicate, parentId)).rejects.toThrow(/duplicate thread id/);

    const self = vi.fn<AppServerReadRequest>().mockResolvedValue({ data: [thread(parentId)], nextCursor: null });
    await expect(readCodexDirectChildren(self, parentId)).rejects.toThrow(/own child/);
  });

  it("rejects malformed response, invalid IDs, and invalid selected metadata", async () => {
    for (const response of [
      null,
      { data: {}, nextCursor: null },
      { data: new Array(1), nextCursor: null },
      { data: [thread("NOT-A-UUID")], nextCursor: null },
      { data: [thread(childId, parentId, { agentRole: 42 })], nextCursor: null },
      Object.assign(Object.create({ inherited: true }), { data: [], nextCursor: null }),
    ]) {
      const request = vi.fn<AppServerReadRequest>().mockResolvedValue(response);
      await expect(readCodexDirectChildren(request, parentId)).rejects.toThrow();
    }

    const accessor = { data: [thread(childId)], nextCursor: null };
    Object.defineProperty(accessor.data[0], "id", { get: () => childId });
    await expect(readCodexDirectChildren(vi.fn<AppServerReadRequest>().mockResolvedValue(accessor), parentId))
      .rejects.toThrow(/accessor id/);
    await expect(readCodexDirectChildren(vi.fn<AppServerReadRequest>(), parentId.toUpperCase())).rejects.toThrow(/parentThreadId/);
  });

  it("enforces page bounds and rejects repeated cursors", async () => {
    const request = vi.fn<AppServerReadRequest>().mockResolvedValue({ data: [], nextCursor: "next" });
    await expect(readCodexDirectChildren(request, parentId, { maxPages: 1 })).rejects.toThrow(/page limit/);
    expect(request).toHaveBeenCalledTimes(1);

    const repeated = vi.fn<AppServerReadRequest>()
      .mockResolvedValueOnce({ data: [], nextCursor: "same" })
      .mockResolvedValueOnce({ data: [], nextCursor: "same" });
    await expect(readCodexDirectChildren(repeated, parentId)).rejects.toThrow(/repeated cursor/);
    await expect(readCodexDirectChildren(request, parentId, { maxPages: 21 })).rejects.toThrow(/maxPages/);
    await expect(readCodexDirectChildren(request, parentId, { pageSize: 101 })).rejects.toThrow(/pageSize/);
  });

  it("rejects inherited, accessor, and unknown options without evaluating getters", async () => {
    const request = vi.fn<AppServerReadRequest>();
    await expect(readCodexDirectChildren(request, parentId, Object.create({ pageSize: 1 })))
      .rejects.toThrow(/invalid options/);

    let getterCalls = 0;
    const accessorOptions = Object.defineProperty({}, "pageSize", {
      enumerable: true,
      get() { getterCalls += 1; return 1; },
    });
    await expect(readCodexDirectChildren(request, parentId, accessorOptions)).rejects.toThrow(/invalid option pageSize/);
    expect(getterCalls).toBe(0);
    await expect(readCodexDirectChildren(request, parentId, { pageSize: 1, unexpected: true } as never))
      .rejects.toThrow(/unknown option/);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects control characters and oversized cursors", async () => {
    for (const cursor of ["bad\u0000cursor", "x".repeat(4097)]) {
      const request = vi.fn<AppServerReadRequest>().mockResolvedValue({ data: [], nextCursor: cursor });
      await expect(readCodexDirectChildren(request, parentId)).rejects.toThrow(/nextCursor/);
    }
  });

  it("propagates request failures", async () => {
    const request = vi.fn<AppServerReadRequest>().mockRejectedValue(new Error("transport closed"));
    await expect(readCodexDirectChildren(request, parentId)).rejects.toThrow("transport closed");
  });
});
