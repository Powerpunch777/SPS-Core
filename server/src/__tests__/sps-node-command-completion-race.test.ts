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
  spsNodeRunnerProfiles,
  spsNodes,
  spsPluginExecutionGrants,
  spsPluginNodeRuns,
  spsWorkspaceExecutionControl,
} from "../compat/paperclip/db.js";
import { spsNodeSignedRequestMessage } from "../compat/paperclip/shared.js";
import { createSpsNodeCompletionReceiptDigest } from "../services/sps-node-completion-receipt.js";
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
    limit() { return this; },
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
      return Promise.resolve().then(read).then(resolve, reject);
    },
  };
  return builder;
}

describe("SPS Node completion receipt digest", () => {
  it("matches the Desktop agent-command and plugin-run vectors", () => {
    expect(createSpsNodeCompletionReceiptDigest({
      kind: "agent-command",
      nodeId: "22222222-2222-4222-8222-222222222222",
      commandId: "11111111-1111-4111-8111-111111111111",
      completion: { status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "stopped" },
    })).toBe("c12692f8ab383fea663f1031848d6b00f27af30efc6d3bd703d276d9a01978d5");
    expect(createSpsNodeCompletionReceiptDigest({
      kind: "plugin-run",
      nodeId: "22222222-2222-4222-8222-222222222222",
      commandId: "11111111-1111-4111-8111-111111111111",
      completion: {
        status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "stopped",
        usageReport: { schemaVersion: 1, source: "claude_model_usage_v1", inputTokens: 9, cachedInputTokens: 0, outputTokens: 2 },
      },
    })).toBe("9c657a910c93dc859bb3df9feff8dbcfa1d5b81f2c10196b9fb7a2f44c28a3fe");
  });
});

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

  it("returns the durable cancellation receipt after a lost response without enqueueing the effect twice", async () => {
    const companyId = "company-1", nodeId = "node-1", commandId = "command-1", agentId = "agent-1", runId = "run-1";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const node = {
      id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
    };
    const command = {
      id: commandId, companyId, nodeId, agentId, heartbeatRunId: runId, runnerProfileId: null,
      workspaceExecutionEpoch: "0", status: "claimed", error: null, lastEventSeq: 0,
    };
    const parent = {
      id: runId, companyId, status: "cancelling", workspaceExecutionEpoch: "0",
      contextSnapshot: { spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending" },
    };
    const state = {
      command: { ...command } as typeof command | (typeof command & { status: string; finishedAt: Date; exitCode: number; signal: null; timedOut: number; completionReceiptDigest: string }),
      parent: { ...parent, contextSnapshot: { ...parent.contextSnapshot } },
      nonces: new Set<string>(),
      commandWrites: 0,
      parentWrites: 0,
    };
    const control = { companyId, state: "stopped", epoch: "1", revision: 2, updatedAt: new Date() };
    const makeDb = () => {
      const db = {
        select(projection?: unknown) {
          let table: unknown;
          const builder = query(() => {
            if (table === spsNodes) return [node];
            if (table === spsNodeHeartbeats) return [];
            if (table === spsNodeCommands) return projection ? [] : [state.command];
            if (table === spsNodeAgentGrants || table === spsAgentNodeBindings) return [{ id: "authorized" }];
            if (table === companies) return [{ id: companyId, status: "active" }];
            if (table === spsWorkspaceExecutionControl) return [control];
            if (table === heartbeatRuns) return [state.parent];
            if (table === agents) return [];
            return [];
          });
          return { ...builder, from(value: unknown) { table = value; return this; } };
        },
        delete() { return { where: async () => undefined }; },
        insert(table: unknown) {
          return {
            values(value: { nonceHash?: string }) {
              if (table === spsNodeHeartbeats && value.nonceHash) state.nonces.add(value.nonceHash);
              return { onConflictDoNothing: async () => undefined };
            },
          };
        },
        update(table: unknown) {
          return {
            set(value: Record<string, unknown>) {
              let applied = false;
              const apply = () => {
                if (applied) return [];
                applied = true;
                if (table === spsNodeCommands && ["claimed", "running", "cancelling"].includes(state.command.status)) {
                  state.commandWrites += 1;
                  state.command = { ...state.command, ...value } as typeof state.command;
                  return [state.command];
                }
                if (table === heartbeatRuns) {
                  state.parentWrites += 1;
                  state.parent = { ...state.parent, ...value } as typeof state.parent;
                  return [state.parent];
                }
                return [];
              };
              return {
                where() {
                  return {
                    returning: async () => apply(),
                    then(resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) {
                      return Promise.resolve().then(apply).then(resolve, reject);
                    },
                  };
                },
              };
            },
          };
        },
        async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(db); },
      };
      return db;
    };
    const db = makeDb();
    const path = `/sps-nodes/${nodeId}/commands/${commandId}/complete`;
    const makeBody = (nonce: string) => {
      const payload = { status: "succeeded", exitCode: 0, signal: null, timedOut: false, error: null };
      const timestamp = new Date().toISOString();
      const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
      const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
      return { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") };
    };
    let auditCalls = 0;
    const context = (effects: Array<() => Promise<unknown> | unknown>) => ({
      userId: "user-1",
      signatureMethod: "POST",
      signaturePath: path,
      authorizeWorkspace: () => undefined,
      authorizeNode: () => undefined,
      logMutation: () => { auditCalls += 1; },
      afterCommit: (effect: () => Promise<unknown> | unknown) => { effects.push(effect); },
    });

    // This models a committed service operation whose HTTP response is lost:
    // the durable database state remains, while the caller discards its service instance.
    const firstEffects: Array<() => Promise<unknown> | unknown> = [];
    const first = await createSpsNodeOperations(db as never).invoke({ operation: "command-complete", nodeId,
      resourceId: commandId, payload: makeBody(`lost-response-nonce-${"a".repeat(24)}`) }, context(firstEffects));
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ id: commandId, status: "cancelled", error: "Workspace execution was stopped." });
    expect(state.command.status).toBe("cancelled");
    expect(state.command.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({
      kind: "agent-command", nodeId, commandId,
      completion: { status: "succeeded", exitCode: 0, signal: null, timedOut: false, error: null },
    }));
    expect(state.parent.contextSnapshot).toMatchObject({
      spsSessionCancellationTermination: "confirmed",
      spsNodeCompletionReceipts: { [commandId]: true },
    });
    expect(state.nonces.size).toBe(1);
    expect(state.commandWrites).toBe(1);
    expect(state.parentWrites).toBe(1);
    expect(firstEffects).toHaveLength(1);
    // The operation context owns dispatching this external effect. Keep it
    // captured here; invoking it would exercise heartbeatService, not the
    // durable completion/retry contract under test.

    const retryEffects: Array<() => Promise<unknown> | unknown> = [];
    const retry = await createSpsNodeOperations(db as never).invoke({ operation: "command-complete", nodeId,
      resourceId: commandId, payload: makeBody(`response-retry-nonce-${"b".repeat(24)}`) }, context(retryEffects));
    expect(retry.status).toBe(200);
    expect(retry.data).toMatchObject({ id: commandId, status: "cancelled", error: "Workspace execution was stopped." });
    expect(retry.data).toEqual(first.data);
    expect(state.parent.contextSnapshot.spsNodeCompletionReceipts).toEqual({ [commandId]: true });
    expect(retryEffects).toHaveLength(0);
    expect(state.nonces.size).toBe(2);
    expect(state.commandWrites).toBe(1);
    expect(state.parentWrites).toBe(1);
    expect(auditCalls).toBe(0);
  });
});

describe("SPS plugin run completion race", () => {
  it.each(["terminal", "missing", "reassigned", "accepted"] as const)(
    "returns the exact-node %s result after a concurrent completion wins the CAS",
    async (outcome) => {
      const companyId = "company-1", nodeId = "node-1", runId = "plugin-run-1", runnerProfileId = "runner-1";
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const node = {
        id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
      };
      const activeRun = {
        id: runId, companyId, nodeId, executionGrantId: "grant-1", pluginKey: "example.plugin", subjectKey: "subject-1",
        runnerProfileId, workspaceSourceId: null, workspaceExecutionEpoch: "0", status: "running", error: null,
        lastEventSeq: 0, cwdHint: null,
      };
      const expectedDigest = createSpsNodeCompletionReceiptDigest({
        kind: "plugin-run", nodeId, commandId: runId,
        completion: { status: "succeeded", exitCode: 0, signal: null, timedOut: false, error: null },
      });
      const terminalRun = {
        ...activeRun, status: "succeeded", exitCode: 0, signal: null, timedOut: 0, error: null,
        usageJson: null, completionReceiptDigest: expectedDigest, finishedAt: new Date("2026-10-28T00:00:00.000Z"),
      };
      let storedRun: Record<string, unknown> | null = { ...activeRun };
      let initialRunReads = 0;
      let updateAttempted = false;
      const makeDb = () => {
        const db = {
          select(projection?: unknown) {
            let table: unknown;
            const builder = query(() => {
              if (table === spsNodes) return [node];
              if (table === spsNodeHeartbeats) return [];
              if (table === spsPluginNodeRuns) {
                if (!initialRunReads++) return [activeRun];
                return storedRun?.nodeId === nodeId ? [storedRun] : [];
              }
              if (table === spsPluginExecutionGrants) return [{ id: "grant-1", workspaceSourceId: null }];
              if (table === spsNodeRunnerProfiles) return [{ id: runnerProfileId, kind: "codex_cli", credentialStatus: null, availabilityStatus: "available" }];
              if (table === companies) return [{ id: companyId, status: "active" }];
              if (table === spsWorkspaceExecutionControl) return [{ companyId, state: "running", epoch: "0", revision: 1, updatedAt: new Date() }];
              return [];
            });
            return { ...builder, from(value: unknown) { table = value; return this; } };
          },
          delete() { return { where: async () => undefined }; },
          insert() { return { values() { return { onConflictDoNothing: async () => undefined }; } }; },
          update(table: unknown) {
            return {
              set(value: Record<string, unknown>) {
                return {
                  where() {
                    return {
                      returning: async () => {
                        if (table === spsPluginNodeRuns && !updateAttempted) {
                          updateAttempted = true;
                          if (outcome === "accepted") {
                            storedRun = { ...activeRun, ...value };
                            return [storedRun];
                          }
                          storedRun = outcome === "terminal" ? { ...terminalRun }
                            : outcome === "missing" ? null : { ...terminalRun, nodeId: "node-2" };
                        }
                        return [];
                      },
                    };
                  },
                };
              },
            };
          },
          async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(db); },
        };
        return db;
      };
      const db = makeDb();
      const path = `/sps-nodes/${nodeId}/plugin-runs/${runId}/complete`;
      const payload = { status: "succeeded", exitCode: 0, signal: null, timedOut: false, error: null };
      const timestamp = new Date().toISOString();
      const nonce = `plugin-complete-race-${outcome}-${"c".repeat(24)}`;
      const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
      const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
      const body = { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") };
      let afterCommitCalls = 0;
      const operation = createSpsNodeOperations(db as never).invoke({ operation: "plugin-complete", nodeId, resourceId: runId, payload: body }, {
        userId: "user-1", signatureMethod: "POST", signaturePath: path,
        authorizeWorkspace: () => undefined, authorizeNode: () => undefined, logMutation: () => undefined,
        afterCommit: () => { afterCommitCalls += 1; },
      });

      if (outcome === "terminal") {
        const result = await operation;
        expect(result.status).toBe(200);
        expect(result.data).toEqual(terminalRun);
      } else if (outcome === "accepted") {
        const result = await operation;
        expect(result.status).toBe(200);
        expect(result.data).toMatchObject({ status: "succeeded", completionReceiptDigest: expectedDigest });
      } else {
        await expect(operation).rejects.toMatchObject({ status: 404, message: "SPS plugin run not found" });
      }
      expect(updateAttempted).toBe(true);
      expect(initialRunReads).toBe(outcome === "accepted" ? 1 : 2);
      expect(afterCommitCalls).toBe(0);
    },
  );
});
