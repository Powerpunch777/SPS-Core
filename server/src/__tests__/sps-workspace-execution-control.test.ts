import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, pluginJobRuns, pluginJobs, plugins, spsModelConnections,
  spsModelRuns, spsNodeCommands, spsNodeRunnerProfiles, spsPluginExecutionGrants, spsPluginNodeRuns, spsNodes, type Db } from "@paperclipai/db";
import {
  assertSpsWorkspaceExecutionActive, assertSpsWorkspaceExecutionReadyForDeletion, getSpsWorkspaceExecutionControl, getSpsWorkspaceExecutionPending,
  registerSpsWorkspaceExecutionStopHandler, spsWorkspaceExecutionControlService,
  withSpsWorkspaceExecutionAdmission,
} from "../services/sps-workspace-execution-control.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createSpsNodeCompletionReceiptDigest } from "../services/sps-node-completion-receipt.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;
databaseSuite("durable Workspace execution admission", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-workspace-control-");
    db = createDb(database.connectionString);
  }, 180_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); }, 30_000);
  const workspace = async () => {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Execution control fixture", issuePrefix: `E${id.replaceAll("-", "")}` });
    return id;
  };

  it("pause blocks new work, preserves active generation and leaves another Workspace running", async () => {
    const a = await workspace(), b = await workspace(), service = spsWorkspaceExecutionControlService(db);
    const epochA = await withSpsWorkspaceExecutionAdmission(db, a, async (_tx, epoch) => epoch);
    const paused = await service.transition(a, "pause", "fixture-owner", 0);
    expect(paused.state).toBe("paused");
    await expect(withSpsWorkspaceExecutionAdmission(db, a, async () => true)).rejects.toMatchObject({ status: 409 });
    await expect(assertSpsWorkspaceExecutionActive(db, a, epochA)).resolves.toBeUndefined();
    await expect(withSpsWorkspaceExecutionAdmission(db, b, async () => "B continues")).resolves.toBe("B continues");
    const resumed = await service.transition(a, "resume", "fixture-owner", paused.revision);
    expect(resumed.epoch).toBe(epochA);
    await expect(withSpsWorkspaceExecutionAdmission(db, a, async () => true)).resolves.toBe(true);
  });

  it("stop persists before cancellation and resume never authorizes the old generation", async () => {
    const a = await workspace(), service = spsWorkspaceExecutionControlService(db);
    const original = await withSpsWorkspaceExecutionAdmission(db, a, async (_tx, epoch) => epoch);
    let observed: unknown;
    const unregister = registerSpsWorkspaceExecutionStopHandler(db, "fixture-stop", async (id, _reason, epoch) => {
      observed = { id, epoch, state: (await getSpsWorkspaceExecutionControl(db, id)).state };
      throw new Error("fixture cancellation still pending");
    });
    try {
      const stopped = await service.transition(a, "stop", "fixture-owner", 0);
      expect(observed).toEqual({ id: a, epoch: "1", state: "stopped" });
      expect(stopped.cancellationFailures).toEqual(["fixture-stop"]);
      expect((await spsWorkspaceExecutionControlService(db).get(a)).state).toBe("stopped");
      await expect(withSpsWorkspaceExecutionAdmission(db, a, async () => true)).rejects.toMatchObject({ status: 409 });
      await service.transition(a, "resume", "fixture-owner", stopped.revision);
      await expect(assertSpsWorkspaceExecutionActive(db, a, original)).rejects.toMatchObject({ status: 409 });
      await expect(withSpsWorkspaceExecutionAdmission(db, a, async (_tx, epoch) => epoch)).resolves.toBe("1");
      const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, a), eq(activityLog.action, "workspace.execution.stop")));
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toMatchObject({ state: "stopped", epoch: "1", revision: 1 });
    } finally { unregister(); }
  });

  it("a stale control screen cannot overwrite a later action; retry stop keeps its generation", async () => {
    const a = await workspace(), service = spsWorkspaceExecutionControlService(db);
    const stopped = await service.transition(a, "stop", "fixture-owner", 0);
    await expect(service.transition(a, "resume", "fixture-owner", 0)).rejects.toMatchObject({ status: 409 });
    const retry = await service.transition(a, "stop", "fixture-owner", stopped.revision);
    expect(retry.epoch).toBe(stopped.epoch);
    expect(retry.revision).toBe(stopped.revision);
  });

  it("keeps policy-failed claimed Node work pending until closure evidence and preserves legacy completed work", async () => {
    const a = await workspace(), b = await workspace(), now = new Date();
    const [agent] = await db.insert(agents).values({ companyId: a, name: "Closure fixture" }).returning();
    const [node] = await db.insert(spsNodes).values({ companyId: a, ownerUserId: "fixture-owner", displayName: "Closure Node",
      publicKey: "closure-fixture-key", platform: "win32", status: "active", keyVerifiedAt: now }).returning();
    const [runner] = await db.insert(spsNodeRunnerProfiles).values({ companyId: a, nodeId: node.id,
      runnerKey: "closure-fixture", kind: "agy", label: "Closure fixture" }).returning();
    const pluginKey = "sps.closure-fixture", subjectKey = "closure-fixture";
    const [grant] = await db.insert(spsPluginExecutionGrants).values({ companyId: a, pluginKey, subjectKey,
      nodeId: node.id, runnerProfileId: runner.id }).returning();
    const [command, startOnly, legacy, neverStarted] = await db.insert(spsNodeCommands).values([
      { companyId: a, nodeId: node.id, agentId: agent.id, command: "agy", status: "failed", claimedAt: now, startedAt: now, finishedAt: now, error: "Access revoked" },
      { companyId: a, nodeId: node.id, agentId: agent.id, command: "agy", status: "failed", startedAt: now, finishedAt: now, error: "Legacy unknown claim marker" },
      { companyId: a, nodeId: node.id, agentId: agent.id, command: "agy", status: "failed", claimedAt: now, startedAt: now, finishedAt: now, exitCode: 1 },
      { companyId: a, nodeId: node.id, agentId: agent.id, command: "agy", status: "cancelled", finishedAt: now },
    ]).returning();
    const [pluginRun] = await db.insert(spsPluginNodeRuns).values({ companyId: a, pluginKey, subjectKey,
      nodeId: node.id, runnerProfileId: runner.id, executionGrantId: grant.id, command: "agy", status: "failed",
      claimedAt: now, startedAt: now, finishedAt: now, error: "Grant revoked" }).returning();
    expect(legacy.completionReceiptDigest).toBeNull();
    expect(neverStarted.claimedAt).toBeNull();

    const stopped = await spsWorkspaceExecutionControlService(db).transition(a, "stop", "fixture-owner", 0);
    expect(stopped.pending).toMatchObject({ commands: 2, plugins: 1 });
    await expect(db.transaction(tx => assertSpsWorkspaceExecutionReadyForDeletion(tx, a, stopped)))
      .rejects.toMatchObject({ code: "workspace_execution_cleanup_pending" });
    expect(await getSpsWorkspaceExecutionPending(db, b)).toMatchObject({ commands: 0, plugins: 0 });

    const completion = { status: "failed" as const, exitCode: 143, signal: "SIGTERM", timedOut: false, error: "local termination confirmed" };
    for (const row of [command, startOnly]) {
      await db.update(spsNodeCommands).set({ completionReceiptDigest: createSpsNodeCompletionReceiptDigest({
        kind: "agent-command", nodeId: node.id, commandId: row.id, completion,
      }) }).where(eq(spsNodeCommands.id, row.id));
    }
    expect(await getSpsWorkspaceExecutionPending(db, a)).toMatchObject({ commands: 0, plugins: 1 });
    await db.update(spsPluginNodeRuns).set({ completionReceiptDigest: createSpsNodeCompletionReceiptDigest({
      kind: "plugin-run", nodeId: node.id, commandId: pluginRun.id, completion,
    }) }).where(eq(spsPluginNodeRuns.id, pluginRun.id));
    await expect(db.transaction(tx => assertSpsWorkspaceExecutionReadyForDeletion(tx, a, stopped))).resolves.toBeUndefined();
    expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, command.id)))[0])
      .toMatchObject({ status: "failed", error: "Access revoked" });
  });

  it("serializes stop with admitted transactions without blocking another Workspace", async () => {
    const a = await workspace(), b = await workspace(), service = spsWorkspaceExecutionControlService(db);
    let admitted!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { admitted = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = withSpsWorkspaceExecutionAdmission(db, a, async (_tx, epoch) => { admitted(); await gate; return epoch; });
    await Promise.race([ready, admission]);
    const stop = service.transition(a, "stop", "fixture-owner", 0);
    try { await expect(withSpsWorkspaceExecutionAdmission(db, b, async () => true)).resolves.toBe(true); }
    finally { release(); }
    const oldEpoch = await admission;
    await stop;
    await expect(assertSpsWorkspaceExecutionActive(db, a, oldEpoch)).rejects.toMatchObject({ status: 409 });
  });

  it("does not bypass an independently archived or paused Workspace policy", async () => {
    const a = await workspace();
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, a));
    await expect(withSpsWorkspaceExecutionAdmission(db, a, async () => true)).rejects.toMatchObject({ status: 409 });
  });

  it("persists cancellation across lanes without local handlers and preserves another Workspace", async () => {
    const a = await workspace(), b = await workspace();
    const pluginId = randomUUID(), jobId = randomUUID(), pluginKey = `sps.control-${pluginId}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "1.0.0",
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Control fixture", description: "Fixture",
        author: "SPS", categories: ["automation"], capabilities: [], entrypoints: { worker: "./fixture.js" } } });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "fixture", schedule: "* * * * *", scope: "workspace" });
    const [queuedJob, activeJob, otherJob] = await db.insert(pluginJobRuns).values([
      { jobId, pluginId, companyId: a, trigger: "manual", status: "queued" },
      { jobId, pluginId, companyId: a, trigger: "manual", status: "running" },
      { jobId, pluginId, companyId: b, trigger: "manual", status: "running" },
    ]).returning();
    const [agent] = await db.insert(agents).values({ companyId: a, name: "Execution fixture" }).returning();
    const [queuedAgent, activeAgent] = await db.insert(heartbeatRuns).values([
      { companyId: a, agentId: agent.id, status: "queued" }, { companyId: a, agentId: agent.id, status: "running" },
    ]).returning();
    const [node] = await db.insert(spsNodes).values({ companyId: a, ownerUserId: "fixture-owner", displayName: "Fixture Node",
      publicKey: "fixture-public-key", platform: "win32" }).returning();
    const [command] = await db.insert(spsNodeCommands).values({ companyId: a, nodeId: node.id, agentId: agent.id,
      heartbeatRunId: activeAgent.id, status: "claimed", command: "agy" }).returning();
    const [connection] = await db.insert(spsModelConnections).values({ companyId: a, displayName: "Fixture", endpoint: "https://fixture.invalid",
      model: "fixture", timeoutMs: 1000, maxOutputTokens: 100, maxRequestBytes: 1024, maxResponseBytes: 1024,
      maxConcurrentRequests: 2, createdByUserId: "fixture-owner" }).returning();
    const [queuedModel, activeModel] = await db.insert(spsModelRuns).values(["queued", "running"].map(status => ({
      companyId: a, pluginId, pluginKey, connectionId: connection.id, grantRevision: 1, requestKey: randomUUID(), inputHash: "fixture", status,
    }))).returning();
    const service = spsWorkspaceExecutionControlService(db), stopped = await service.transition(a, "stop", "fixture-owner", 0);
    const jobRows = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.jobId, jobId));
    expect(jobRows.find(row => row.id === queuedJob.id)).toMatchObject({ status: "cancelled" });
    expect(jobRows.find(row => row.id === activeJob.id)).toMatchObject({ status: "cancelling", finishedAt: null });
    expect(jobRows.find(row => row.id === otherJob.id)).toMatchObject({ status: "running", cancellationRequestedAt: null });
    const agentRows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id));
    expect(agentRows.find(row => row.id === queuedAgent.id)).toMatchObject({ status: "cancelled", contextSnapshot: { spsSessionCancellationTermination: "confirmed" } });
    expect(agentRows.find(row => row.id === activeAgent.id)).toMatchObject({ status: "running", contextSnapshot: { spsSessionCancellationTermination: "pending" } });
    expect(await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, command.id))).toMatchObject([{ status: "cancelling", finishedAt: null }]);
    const modelRows = await db.select().from(spsModelRuns).where(eq(spsModelRuns.companyId, a));
    expect(modelRows.find(row => row.id === queuedModel.id)).toMatchObject({ status: "cancelled", resourcePending: false });
    expect(modelRows.find(row => row.id === activeModel.id)).toMatchObject({ status: "running", resourcePending: true, finishedAt: null });
    expect(stopped.pending).toMatchObject({ jobs: 1, agents: 1, commands: 1, models: 1 });
    await service.transition(a, "resume", "fixture-owner", stopped.revision);
    expect(await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, queuedJob.id))).toMatchObject([{ status: "cancelled" }]);
    expect((await service.get(b)).state).toBe("running");
  });
});
