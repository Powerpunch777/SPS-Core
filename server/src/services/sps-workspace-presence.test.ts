import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { readSpsWorkspacePresence } from "./sps-workspace-presence.js";

const WORKSPACE_ID = "2b9a1250-4d6f-4b9f-bd74-f62d791fd180";

function createDb(rows: unknown[] | Error) {
  const limit = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    db: { select } as unknown as Pick<Db, "select">,
    select,
    from,
    where,
    limit,
  };
}

describe("readSpsWorkspacePresence", () => {
  it("returns true when the exact Workspace row exists", async () => {
    const query = createDb([{ id: WORKSPACE_ID }]);

    await expect(readSpsWorkspacePresence(query.db, WORKSPACE_ID)).resolves.toBe(true);
    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.from).toHaveBeenCalledTimes(1);
    expect(query.where).toHaveBeenCalledTimes(1);
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it("returns false only when a successful query finds no Workspace row", async () => {
    const query = createDb([]);

    await expect(readSpsWorkspacePresence(query.db, WORKSPACE_ID)).resolves.toBe(false);
    expect(query.where).toHaveBeenCalledTimes(1);
  });

  it("propagates database errors instead of treating them as absence", async () => {
    const error = new Error("database unavailable");
    const query = createDb(error);

    await expect(readSpsWorkspacePresence(query.db, WORKSPACE_ID)).rejects.toBe(error);
  });

  it("rejects an invalid Workspace selector without querying", async () => {
    const query = createDb([]);

    await expect(readSpsWorkspacePresence(query.db, "../workspace")).rejects.toThrow();
    expect(query.select).not.toHaveBeenCalled();
  });
});
