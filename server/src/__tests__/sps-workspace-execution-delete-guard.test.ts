import { describe, expect, it } from "vitest";
import {
  companies, heartbeatRuns, pluginJobRuns, spsModelRuns, spsNodeCommands, spsPluginNodeRuns,
  spsWorkspaceExecutionControl, type Db,
} from "@paperclipai/db";
import {
  assertSpsWorkspaceExecutionReadyForDeletion,
  type SpsWorkspaceExecutionDb,
  SpsWorkspaceExecutionCleanupPendingError,
} from "../services/sps-workspace-execution-control.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const controlRow = { companyId, state: "stopped", epoch: "7", revision: 12, updatedAt: new Date("2026-01-01T00:00:00.000Z") };

function createFakeDb(options: {
  control?: typeof controlRow;
  pendingTable?: object;
  workspaceExists?: boolean;
} = {}) {
  const reads: Array<{ table: object; forUpdate: boolean }> = [];
  const db = {
    select: () => {
      let table: object | undefined;
      let forUpdate = false;
      const query = {
        from(value: object) { table = value; return query; },
        where() { return query; },
        for() { forUpdate = true; return query; },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          const selected = table!;
          reads.push({ table: selected, forUpdate });
          let result: unknown[];
          if (selected === companies) result = options.workspaceExists === false ? [] : [{ id: companyId }];
          else if (selected === spsWorkspaceExecutionControl) result = options.control ? [options.control] : [controlRow];
          else result = [{ value: selected === options.pendingTable ? 1 : 0 }];
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
    insert: () => ({ values() { return this; }, onConflictDoNothing() { return Promise.resolve([]); } }),
  };
  return { db: db as unknown as SpsWorkspaceExecutionDb & Db, reads };
}

describe("Workspace deletion execution guard", () => {
  it("locks the stopped execution row and accepts only its exact token when all lanes are clear", async () => {
    const { db, reads } = createFakeDb();

    await expect(assertSpsWorkspaceExecutionReadyForDeletion(db, companyId, { epoch: "7", revision: 12 }))
      .resolves.toBeUndefined();

    expect(reads).toContainEqual({ table: spsWorkspaceExecutionControl, forUpdate: true });
    expect(reads.map(read => read.table)).toEqual(expect.arrayContaining([
      heartbeatRuns, pluginJobRuns, spsModelRuns, spsNodeCommands, spsPluginNodeRuns,
    ]));
  });

  it.each([
    ["running state", { ...controlRow, state: "running" }],
    ["different epoch", { ...controlRow, epoch: "8" }],
    ["different revision", { ...controlRow, revision: 13 }],
  ])("rejects deletion after a concurrent execution change (%s)", async (_label, control) => {
    const { db, reads } = createFakeDb({ control: control as typeof controlRow });

    await expect(assertSpsWorkspaceExecutionReadyForDeletion(db, companyId, { epoch: "7", revision: 12 }))
      .rejects.toMatchObject({ status: 409 });
    const pendingTables = [heartbeatRuns, pluginJobRuns, spsModelRuns, spsNodeCommands, spsPluginNodeRuns];
    expect(reads.some(read => pendingTables.some(table => table === read.table))).toBe(false);
  });

  it("refuses the transaction while any durable execution lane is pending", async () => {
    const { db } = createFakeDb({ pendingTable: spsNodeCommands });

    await expect(assertSpsWorkspaceExecutionReadyForDeletion(db, companyId, { epoch: "7", revision: 12 }))
      .rejects.toBeInstanceOf(SpsWorkspaceExecutionCleanupPendingError);
  });
});
