import { describe, expect, it } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { getSpsWorkspaceExecutionPending, registerSpsWorkspaceExecutionStopHandler } from "../services/sps-workspace-execution-control.js";

function databaseWithNoDurableRuns() {
  return { select: () => ({ from: () => ({ where: async () => [{ value: 0 }] }) }) } as unknown as Db;
}

describe("Workspace Plugin termination accounting", () => {
  it("keeps owned local resources pending independently of durable runs and another Workspace", async () => {
    const db = databaseWithNoDurableRuns();
    let ownedA = 1;
    const unregister = registerSpsWorkspaceExecutionStopHandler(db, "workspace-workers", async () => {},
      id => id === "workspace-a" ? ownedA : id === "workspace-b" ? 2 : 0);
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-a")).plugins).toBe(1);
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-b")).plugins).toBe(2);
    // A sent stop or process exit does not change this owned-resource observer;
    // only confirmed closure in its owner can release the resource count.
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-a")).plugins).toBe(1);
    ownedA = 0;
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-a")).plugins).toBe(0);
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-b")).plugins).toBe(2);
    unregister();
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-b")).plugins).toBe(0);
  });

  it("does not let an older unregister erase a replacement owner's accounting", async () => {
    const db = databaseWithNoDurableRuns();
    const old = registerSpsWorkspaceExecutionStopHandler(db, "lane", async () => {}, () => 1);
    const current = registerSpsWorkspaceExecutionStopHandler(db, "lane", async () => {}, () => 3);
    old();
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-a")).plugins).toBe(3);
    current();
    expect((await getSpsWorkspaceExecutionPending(db, "workspace-a")).plugins).toBe(0);
  });

  it("rejects unknown resource accounting instead of reporting completed termination", async () => {
    for (const value of [-1, NaN, Infinity, 1.5]) {
      const db = databaseWithNoDurableRuns();
      const unregister = registerSpsWorkspaceExecutionStopHandler(db, "lane", async () => {}, () => value);
      await expect(getSpsWorkspaceExecutionPending(db, "workspace-a")).rejects.toThrow("resource state is unavailable");
      unregister();
    }
  });
});
