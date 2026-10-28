import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agents,
  companies,
  heartbeatRuns,
  spsAgentNodeBindings,
  spsNodeAgentGrants,
  spsNodeCommands,
  spsNodeHeartbeats,
  spsNodes,
  spsWorkspaceExecutionControl,
} from "../compat/paperclip/db.js";
import { spsNodeSignedRequestMessage } from "../compat/paperclip/shared.js";
import { createSpsNodeOperations } from "../services/sps-node-operations.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function query(read: () => unknown) {
  const builder = {
    where() { return this; },
    for() { return this; },
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve().then(read).then(resolve, reject);
    },
  };
  return builder;
}

describe("SPS Node command completion race", () => {
  it.each(["terminal", "missing"] as const)("rereads the %s command after a concurrent completion wins the conditional update", async (outcome) => {
    const companyId = "company-1", nodeId = "node-1", commandId = "command-1", agentId = "agent-1";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const node = {
      id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
    };
    const activeCommand = {
      id: commandId, companyId, nodeId, agentId, heartbeatRunId: null, runnerProfileId: null,
      workspaceExecutionEpoch: "0", status: "claimed", error: null,
    };
    const committedCommand = {
      ...activeCommand, status: "succeeded", exitCode: 0, signal: null, timedOut: 0,
      error: null, finishedAt: new Date("2026-10-28T00:00:00.000Z"),
    };
    let storedCommand: typeof activeCommand | typeof committedCommand | null = activeCommand;
    let initialCommandReads = 0;
    let updateAttempted = false;

    const makeDb = () => ({
      select() {
        let table: unknown;
        const builder = query(() => {
          if (table === spsNodes) return [node];
          if (table === spsNodeHeartbeats) return [];
          if (table === spsNodeCommands) {
            if (!initialCommandReads++) return [activeCommand];
            return storedCommand ? [storedCommand] : [];
          }
          if (table === spsNodeAgentGrants || table === spsAgentNodeBindings) return [{ id: `${String(table)}` }];
          if (table === companies) return [{ id: companyId, status: "active" }];
          if (table === spsWorkspaceExecutionControl) return [{ companyId, state: "running", epoch: "0", revision: 1, updatedAt: new Date() }];
          if (table === heartbeatRuns) return [];
          if (table === agents) return [];
          return [];
        });
        return { ...builder, from(value: unknown) { table = value; return this; } };
      },
      delete() { return { where: async () => undefined }; },
      insert(table: unknown) {
        return { values() { return { onConflictDoNothing: async () => undefined, then: undefined }; } };
      },
      update(table: unknown) {
        return {
          set(_value: unknown) {
            return {
              where() {
                return {
                  returning: async () => {
                    if (table === spsNodeCommands && !updateAttempted) {
                      updateAttempted = true;
                      // Model the competing signed completion committing while
                      // this request waits for the conditional UPDATE.
                      storedCommand = outcome === "terminal" ? committedCommand : null;
                    }
                    return [];
                  },
                };
              },
            };
          },
        };
      },
      async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(makeDb()); },
    });
    const db = makeDb();
    const operations = createSpsNodeOperations(db as never);
    const path = `/sps-nodes/${nodeId}/commands/${commandId}/complete`;
    const payload = { status: "succeeded", exitCode: 0, timedOut: false };
    const timestamp = new Date().toISOString();
    const nonce = `completion-race-nonce-${"a".repeat(32)}`;
    const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
    const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
    const body = { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") };

    let afterCommitCalls = 0;
    const operation = operations.invoke({ operation: "command-complete", nodeId, resourceId: commandId, payload: body }, {
      userId: "user-1",
      signatureMethod: "POST",
      signaturePath: path,
      authorizeWorkspace: () => undefined,
      authorizeNode: () => undefined,
      logMutation: () => undefined,
      afterCommit: () => { afterCommitCalls += 1; },
    });

    if (outcome === "missing") {
      await expect(operation).rejects.toMatchObject({ status: 404, message: "SPS Node command not found" });
    } else {
      const result = await operation;
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ id: commandId, status: "succeeded", finishedAt: committedCommand.finishedAt });
    }
    expect(updateAttempted).toBe(true);
    expect(initialCommandReads).toBe(2);
    expect(afterCommitCalls).toBe(0);
  });
});
