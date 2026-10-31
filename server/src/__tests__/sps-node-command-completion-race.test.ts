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

function lateCommandReportFixture(input: Readonly<{
  status: string;
  claimed: boolean;
  authorized?: boolean;
  parentContext?: Record<string, unknown>;
  workspaceState?: "running" | "stopped";
  workspaceEpoch?: string;
  lockedCommandRead?: "missing" | "reassigned";
  failAdoptionUpdate?: boolean;
  latestCommandRead?: "missing" | "reassigned";
}>) {
  const companyId = "company-late", nodeId = "node-late", commandId = "command-late", runId = "run-late", agentId = "agent-late";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const node = {
    id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
  };
  const claimedAt = input.claimed ? new Date("2026-10-28T00:00:00.000Z") : null;
  const command = {
    id: commandId, companyId, nodeId, agentId, heartbeatRunId: runId, runnerProfileId: null,
    workspaceExecutionEpoch: input.workspaceState === "stopped" ? "0" : input.workspaceEpoch ?? "0", status: input.status, claimedAt, startedAt: claimedAt,
    finishedAt: input.status === "failed" ? new Date("2026-10-28T00:01:00.000Z") : null,
    exitCode: null, signal: null, timedOut: 0, error: input.status === "failed" ? "SPS Node access was revoked" : null,
    completionReceiptDigest: null, completionReportJson: null,
  };
  const parent = {
    id: runId, companyId, status: "cancelling", workspaceExecutionEpoch: "0",
    contextSnapshot: input.parentContext ?? { spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending" },
  };
  const state = { command: { ...command }, parent: { ...parent, contextSnapshot: { ...parent.contextSnapshot } }, parentWrites: 0,
    nonces: new Set<string>(), adoptionUpdateAttempted: false };
  const control = { companyId, state: input.workspaceState ?? "stopped", epoch: input.workspaceState === "stopped" ? "1" : input.workspaceEpoch ?? "0",
    revision: 2, updatedAt: new Date() };
  const db = {
    select(projection?: unknown) {
      let table: unknown;
      let forUpdate = false;
      const builder = query(() => {
        if (table === spsNodes) return [node];
        if (table === spsNodeHeartbeats) return [];
        if (table === spsNodeCommands) {
          if (forUpdate && input.lockedCommandRead === "missing") return [];
          if (forUpdate && input.lockedCommandRead === "reassigned") return [{ ...state.command, nodeId: "node-reassigned" }];
          if (!forUpdate && state.adoptionUpdateAttempted && input.latestCommandRead === "missing") return [];
          if (!forUpdate && state.adoptionUpdateAttempted && input.latestCommandRead === "reassigned") return [{ ...state.command, nodeId: "node-reassigned" }];
          return [state.command];
        }
        if (table === spsNodeAgentGrants || table === spsAgentNodeBindings) return input.authorized === false ? [] : [{ id: "authorized" }];
        if (table === companies) return [{ id: companyId, status: "active" }];
        if (table === spsWorkspaceExecutionControl) return [control];
        if (table === heartbeatRuns) return [state.parent];
        if (table === agents) return [];
        return [];
      });
      return { ...builder, from(value: unknown) { table = value; return this; }, for() { forUpdate = true; return this; } };
    },
    delete() { return { where: async () => undefined }; },
    insert(table: unknown) {
      return { values(value: { nonceHash?: string }) { if (table === spsNodeHeartbeats && value.nonceHash) state.nonces.add(value.nonceHash);
        return { onConflictDoNothing: async () => undefined }; } };
    },
    update(table: unknown) {
      return { set(value: Record<string, unknown>) { let applied = false;
        const apply = () => {
          if (applied) return [];
          applied = true;
          if (table === spsNodeCommands) {
            if (Object.prototype.hasOwnProperty.call(value, "completionReportJson")) {
              state.adoptionUpdateAttempted = true;
              if (input.failAdoptionUpdate) return [];
            }
            state.command = { ...state.command, ...value };
            return [state.command];
          }
          if (table === heartbeatRuns) {
            state.parentWrites += 1;
            state.parent = { ...state.parent, ...value } as typeof state.parent;
            return [state.parent];
          }
          return [];
        };
        return { where() { return { returning: async () => apply(), then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(apply).then(resolve, reject);
        } }; } };
      } };
    },
    async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(db); },
  };
  const path = `/sps-nodes/${nodeId}/commands/${commandId}/complete`;
  const makeBody = (payload: Record<string, unknown>, nonce: string) => {
    const timestamp = new Date().toISOString();
    const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
    const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
    return { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") };
  };
  const invoke = (payload: Record<string, unknown>, nonce: string, afterCommit: () => void) => createSpsNodeOperations(db as never).invoke({
    operation: "command-complete", nodeId, resourceId: commandId, payload: makeBody(payload, nonce),
  }, { userId: "user-1", signatureMethod: "POST", signaturePath: path,
    authorizeWorkspace: () => undefined, authorizeNode: () => undefined, logMutation: () => undefined, afterCommit });
  return { state, db, invoke, companyId, nodeId, commandId, runId };
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
  it("adopts a late signed completion receipt without changing the server failure or repeating cancellation effects", async () => {
    const fixture = lateCommandReportFixture({ status: "running", claimed: true, authorized: false });
    const report = { status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "revoked" };
    let afterCommitCalls = 0;
    const first = await fixture.invoke(report, `late-report-${"a".repeat(24)}`, () => { afterCommitCalls += 1; });

    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ status: "failed", error: "SPS Node access was revoked or reassigned while this command was running.", exitCode: null });
    expect(fixture.state.command).toMatchObject({
      status: "failed", error: "SPS Node access was revoked or reassigned while this command was running.", exitCode: null,
      completionReportJson: { status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "revoked" },
      completionReceiptDigest: createSpsNodeCompletionReceiptDigest({ kind: "agent-command", nodeId: fixture.nodeId,
        commandId: fixture.commandId, completion: report }),
    });
    expect(fixture.state.parent.contextSnapshot).toMatchObject({
      spsSessionCancellationTermination: "confirmed", spsNodeCompletionReceipts: { [fixture.commandId]: true },
    });
    expect(afterCommitCalls).toBe(1);

    const retry = await fixture.invoke(report, `late-retry-${"b".repeat(24)}`, () => { afterCommitCalls += 1; });
    expect(retry.data).toEqual(first.data);
    expect(afterCommitCalls).toBe(1);

    const storedReport = fixture.state.command.completionReportJson;
    const conflict = await fixture.invoke({ ...report, exitCode: 2 }, `late-conflict-${"c".repeat(24)}`, () => { afterCommitCalls += 1; });
    expect(conflict.data).toEqual(first.data);
    expect(fixture.state.command.completionReportJson).toEqual(storedReport);
    expect(fixture.state.command.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({ kind: "agent-command",
      nodeId: fixture.nodeId, commandId: fixture.commandId, completion: report }));
    expect(afterCommitCalls).toBe(1);
  });

  it.each(["queued", "failed"] as const)("does not adopt a %s command report without claim evidence", async (status) => {
    const fixture = lateCommandReportFixture({ status, claimed: false });
    const report = { status: "failed", exitCode: 1, timedOut: false };
    let afterCommitCalls = 0;
    if (status === "queued") {
      await expect(fixture.invoke(report, `unclaimed-${"d".repeat(24)}`, () => { afterCommitCalls += 1; }))
        .rejects.toMatchObject({ status: 403 });
    } else {
      const response = await fixture.invoke(report, `unclaimed-${"e".repeat(24)}`, () => { afterCommitCalls += 1; });
      expect(response.data).toMatchObject({ status: "failed", error: "SPS Node access was revoked" });
    }
    expect(fixture.state.command.completionReportJson).toBeNull();
    expect(fixture.state.command.completionReceiptDigest).toBeNull();
    expect(fixture.state.parent.contextSnapshot.spsNodeCompletionReceipts).toBeUndefined();
    expect(afterCommitCalls).toBe(0);
  });

  it.each(["missing", "reassigned"] as const)("returns 404 when the late-report locked reread is %s", async (outcome) => {
    const fixture = lateCommandReportFixture({ status: "failed", claimed: true, lockedCommandRead: outcome });
    await expect(fixture.invoke({ status: "failed", exitCode: 1 }, `locked-${outcome}-${"g".repeat(20)}`, () => undefined))
      .rejects.toMatchObject({ status: 404, message: "SPS Node command not found" });
  });

  it.each(["missing", "reassigned"] as const)("returns 404 when the late-report CAS reread is %s", async (outcome) => {
    const fixture = lateCommandReportFixture({ status: "failed", claimed: true, failAdoptionUpdate: true, latestCommandRead: outcome });
    await expect(fixture.invoke({ status: "failed", exitCode: 1 }, `cas-${outcome}-${"h".repeat(20)}`, () => undefined))
      .rejects.toMatchObject({ status: 404, message: "SPS Node command not found" });
  });

  it("marks the parent cancellation when a stopped Workspace cancels the command without a prior parent marker", async () => {
    const fixture = lateCommandReportFixture({ status: "running", claimed: true, parentContext: {}, workspaceState: "stopped" });
    let afterCommitCalls = 0;
    const result = await fixture.invoke({ status: "succeeded", exitCode: 0, timedOut: false },
      `workspace-stop-${"i".repeat(20)}`, () => { afterCommitCalls += 1; });

    expect(result.data).toMatchObject({ status: "cancelled", error: "Workspace execution was stopped." });
    expect(fixture.state.parent.contextSnapshot).toMatchObject({
      spsSessionCancellationRequested: true,
      spsSessionCancellationTermination: "confirmed",
      spsNodeCompletionReceipts: { [fixture.commandId]: true },
    });
    expect(afterCommitCalls).toBe(1);
  });

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
      claimedAt: new Date("2026-10-28T00:00:00.000Z"), startedAt: new Date("2026-10-28T00:00:01.000Z"), finishedAt: null,
      completionReportJson: null,
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
            if (table === spsNodeCommands) return [state.command];
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

  it.each(["failed", "running"] as const)("requires signed completion evidence for a %s claimed sibling", async (siblingStatus) => {
    const companyId = "company-1", nodeId = "node-1", commandId = "command-1", siblingId = "command-2", agentId = "agent-1", runId = "run-1";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const node = {
      id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
    };
    const claimedAt = new Date("2026-10-28T00:00:00.000Z");
    const commands = [
      { id: commandId, companyId, nodeId, agentId, heartbeatRunId: runId, runnerProfileId: null,
        workspaceExecutionEpoch: "0", status: "claimed", claimedAt, startedAt: claimedAt, finishedAt: null,
        error: null, lastEventSeq: 0, completionReceiptDigest: null },
      // failActiveNodeCommand can make this row terminal without evidence
      // that the remote Node process exited.
      { id: siblingId, companyId, nodeId, agentId, heartbeatRunId: runId, runnerProfileId: null,
        workspaceExecutionEpoch: "0", status: siblingStatus, claimedAt, startedAt: claimedAt,
        finishedAt: siblingStatus === "failed" ? new Date() : null,
        error: siblingStatus === "failed" ? "Node access was revoked" : null,
        lastEventSeq: 0, completionReceiptDigest: null },
    ];
    const parent = { id: runId, companyId, status: "cancelling", workspaceExecutionEpoch: "0",
      contextSnapshot: { spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending" } };
    const state = { commands, selectedIndex: 0, parent: { ...parent, contextSnapshot: { ...parent.contextSnapshot } }, nonces: new Set<string>(), parentWrites: 0 };
    const control = { companyId, state: "stopped", epoch: "1", revision: 2, updatedAt: new Date() };
    const db = {
      select(projection?: unknown) {
        let table: unknown;
        const builder = query(() => {
          if (table === spsNodes) return [node];
          if (table === spsNodeHeartbeats) return [];
          if (table === spsNodeCommands) return projection ? state.commands : [state.commands[state.selectedIndex]];
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
        return { values(value: { nonceHash?: string }) { if (table === spsNodeHeartbeats && value.nonceHash) state.nonces.add(value.nonceHash);
          return { onConflictDoNothing: async () => undefined }; } };
      },
      update(table: unknown) {
        return { set(value: Record<string, unknown>) { let applied = false;
          const apply = () => {
            if (applied) return [];
            applied = true;
            const selected = state.commands[state.selectedIndex];
            if (table === spsNodeCommands && ["claimed", "running", "cancelling"].includes(selected.status)) {
              state.commands[state.selectedIndex] = { ...selected, ...value } as typeof state.commands[number];
              return [state.commands[state.selectedIndex]];
            }
            if (table === heartbeatRuns) {
              state.parentWrites += 1;
              state.parent = { ...state.parent, ...value } as typeof state.parent;
              return [state.parent];
            }
            return [];
          };
          return { where() { return { returning: async () => apply(), then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            return Promise.resolve().then(apply).then(resolve, reject);
          } }; } };
        } };
      },
      async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(db); },
    };
    const payload = { status: "succeeded", exitCode: 0, signal: null, timedOut: false, error: null };
    const makeBody = (targetId: string, suffix: string) => {
      const path = `/sps-nodes/${nodeId}/commands/${targetId}/complete`;
      const timestamp = new Date().toISOString(), nonce = `sibling-${suffix}-${"a".repeat(24)}`;
      const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
      const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
      return { path, body: { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") } };
    };
    let afterCommitCalls = 0;
    const invoke = async (targetId: string, suffix: string) => {
      const { path, body } = makeBody(targetId, suffix);
      return createSpsNodeOperations(db as never).invoke({ operation: "command-complete", nodeId,
        resourceId: targetId, payload: body }, {
        userId: "user-1", signatureMethod: "POST", signaturePath: path,
        authorizeWorkspace: () => undefined, authorizeNode: () => undefined, logMutation: () => undefined,
        afterCommit: () => { afterCommitCalls += 1; },
      });
    };
    const result = await invoke(commandId, "first");

    expect(result.status).toBe(200);
    expect(state.commands[0].completionReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
    if (siblingStatus === "failed") {
      expect(state.parent.contextSnapshot).toMatchObject({
        spsSessionCancellationTermination: "pending",
        spsNodeCompletionReceipts: { [commandId]: true },
      });
      expect(state.parentWrites).toBe(1);
      expect(afterCommitCalls).toBe(0);
      return;
    }

    expect(state.parent.contextSnapshot).toMatchObject({ spsSessionCancellationTermination: "pending" });
    expect(afterCommitCalls).toBe(0);
    state.selectedIndex = 1;
    const siblingResult = await invoke(siblingId, "second");
    expect(siblingResult.status).toBe(200);
    expect(state.commands[1].completionReceiptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(state.parent.contextSnapshot).toMatchObject({
      spsSessionCancellationTermination: "confirmed",
      spsNodeCompletionReceipts: { [commandId]: true, [siblingId]: true },
    });
    expect(state.parentWrites).toBe(2);
    expect(afterCommitCalls).toBe(1);
    await invoke(siblingId, "retry");
    expect(state.parentWrites).toBe(2);
    expect(afterCommitCalls).toBe(1);
  });
});

describe("SPS plugin run completion race", () => {
  it("stores a late signed plugin completion report without changing terminal status", async () => {
    const companyId = "company-plugin-late", nodeId = "node-plugin-late", runId = "plugin-run-late", runnerProfileId = "runner-plugin-late";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const node = {
      id: nodeId, companyId, ownerUserId: "user-1", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "active", keyVerifiedAt: new Date(), transportPublicKey: null,
    };
    const claimedAt = new Date("2026-10-28T00:00:00.000Z");
    const state = { run: {
      id: runId, companyId, nodeId, executionGrantId: "grant-1", pluginKey: "example.plugin", subjectKey: "subject-1",
      runnerProfileId, workspaceSourceId: null, workspaceExecutionEpoch: "0", status: "failed", error: "Grant revoked",
      claimedAt, startedAt: claimedAt, finishedAt: new Date("2026-10-28T00:01:00.000Z"), exitCode: null,
      signal: null, timedOut: 0, completionReceiptDigest: null, completionReportJson: null, usageJson: null,
    } };
    const control = { companyId, state: "running", epoch: "0", revision: 1, updatedAt: new Date() };
    const db = {
      select() {
        let table: unknown;
        const builder = query(() => {
          if (table === spsNodes) return [node];
          if (table === spsNodeHeartbeats) return [];
          if (table === spsPluginNodeRuns) return [state.run];
          if (table === companies) return [{ id: companyId, status: "active" }];
          if (table === spsWorkspaceExecutionControl) return [control];
          return [];
        });
        return { ...builder, from(value: unknown) { table = value; return this; } };
      },
      delete() { return { where: async () => undefined }; },
      insert() { return { values() { return { onConflictDoNothing: async () => undefined }; } }; },
      update(table: unknown) {
        return { set(value: Record<string, unknown>) { let applied = false;
          const apply = () => {
            if (applied || table !== spsPluginNodeRuns) return [];
            applied = true;
            state.run = { ...state.run, ...value };
            return [state.run];
          };
          return { where() { return { returning: async () => apply(), then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
            return Promise.resolve().then(apply).then(resolve, reject);
          } }; } };
        } };
      },
      async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(db); },
    };
    const path = `/sps-nodes/${nodeId}/plugin-runs/${runId}/complete`;
    const report = { status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "stopped" };
    const makeBody = (nonce: string, payload: Record<string, unknown>) => {
      const timestamp = new Date().toISOString(), bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
      const message = spsNodeSignedRequestMessage({ nodeId, method: "POST", path, timestamp, nonce, bodySha256 });
      return { ...payload, timestamp, nonce, signature: sign(null, Buffer.from(message), privateKey).toString("base64") };
    };
    const invoke = (nonce: string, payload = report) => createSpsNodeOperations(db as never).invoke({
      operation: "plugin-complete", nodeId, resourceId: runId, payload: makeBody(nonce, payload),
    }, { userId: "user-1", signatureMethod: "POST", signaturePath: path,
      authorizeWorkspace: () => undefined, authorizeNode: () => undefined, logMutation: () => undefined });

    const first = await invoke(`plugin-late-${"f".repeat(24)}`);
    expect(first.data).toMatchObject({ status: "failed", error: "Grant revoked", exitCode: null });
    expect(state.run).toMatchObject({
      status: "failed", error: "Grant revoked", exitCode: null,
      completionReportJson: { ...report, signal: "SIGTERM" },
      completionReceiptDigest: createSpsNodeCompletionReceiptDigest({ kind: "plugin-run", nodeId, commandId: runId, completion: report }),
    });
    const storedReport = state.run.completionReportJson;
    const retry = await invoke(`plugin-retry-${"f".repeat(24)}`);
    expect(retry.data).toEqual(first.data);
    const conflict = await invoke(`plugin-conflict-${"f".repeat(24)}`, { ...report, exitCode: 1 });
    expect(conflict.data).toEqual(first.data);
    expect(state.run.completionReportJson).toEqual(storedReport);
    expect(state.run.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({ kind: "plugin-run", nodeId,
      commandId: runId, completion: report }));
  });

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
