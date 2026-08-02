import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, pluginCompanySettings, pluginJobRuns, pluginJobs, plugins } from "@paperclipai/db";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("workspace-scoped plugin jobs", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const worker = { isRunning: vi.fn(() => true), call: vi.fn(async () => undefined) } as any;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("sps-workspace-plugin-jobs-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterEach(async () => {
    worker.call.mockClear();
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });
  afterAll(async () => { await temp.cleanup(); });

  async function seed(dependencyBlocked = false) {
    const pluginId = randomUUID();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const companyC = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "A", issuePrefix: "JBA" },
      { id: companyB, name: "B", issuePrefix: "JBB" },
      { id: companyC, name: "C", issuePrefix: "JBC" },
    ]);
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "sps.jobs-test", packageName: "jobs-test", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: "sps.jobs-test", apiVersion: 1, version: "1.0.0", displayName: "Jobs", description: "Jobs", author: "SPS", categories: ["automation"], capabilities: [], entrypoints: { worker: "./worker.js" }, ...(dependencyBlocked ? { requiredDependencies: [{ id: "sps.unavailable" }] } : {}) },
    });
    await db.insert(pluginCompanySettings).values({ pluginId, companyId: companyB, enabled: false, settingsJson: {} });
    const workspaceJobId = randomUUID();
    const hostJobId = randomUUID();
    await db.insert(pluginJobs).values([
      { id: workspaceJobId, pluginId, jobKey: "workspace", schedule: "* * * * *", scope: "workspace", nextRunAt: new Date(Date.now() - 1_000) },
      { id: hostJobId, pluginId, jobKey: "host", schedule: "* * * * *", scope: "host", nextRunAt: new Date(Date.now() - 1_000) },
    ]);
    return { pluginId, companyA, companyB, companyC, workspaceJobId, hostJobId };
  }

  it("runs enabled workspaces independently, skips disabled workspaces, and runs Host jobs once", async () => {
    const seedData = await seed();
    const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker, maxConcurrentJobs: 1 });
    await scheduler.tick();
    // The global limit may defer the next distinct job definition to the
    // following scheduler tick after all workspace targets complete.
    await scheduler.tick();
    const runs = await db.select().from(pluginJobRuns);
    expect(runs
      .filter((run) => run.jobId === seedData.workspaceJobId)
      .map((run) => run.companyId)
      .sort()).toEqual([seedData.companyA, seedData.companyC].sort());
    expect(runs.filter((run) => run.jobId === seedData.hostJobId).map((run) => run.companyId)).toEqual([null]);
    expect(worker.call.mock.calls.some(([, , input]) => input.job.companyId === seedData.companyA)).toBe(true);
    expect(worker.call.mock.calls.some(([, , input]) => input.job.companyId === seedData.companyC)).toBe(true);
    expect(worker.call.mock.calls.some(([, , input]) => input.job.companyId === seedData.companyB)).toBe(false);
  });

  it("skips workspace job targets whose Company dependency graph is blocked", async () => {
    const seedData = await seed(true);
    const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    await scheduler.tick();
    const runs = await db.select().from(pluginJobRuns);
    expect(runs.filter((run) => run.jobId === seedData.workspaceJobId)).toHaveLength(0);
    expect(worker.call).not.toHaveBeenCalled();
  });

  it("requires workspace scope for manual triggers and preserves it on retry", async () => {
    const { companyA, workspaceJobId } = await seed();
    const store = pluginJobStore(db);
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: worker });
    await expect(scheduler.triggerJob(workspaceJobId)).rejects.toThrow("requires a companyId");
    worker.call.mockRejectedValueOnce(new Error("expected"));
    const first = await scheduler.triggerJob(workspaceJobId, "manual", companyA);
    await vi.waitFor(async () => {
      expect((await store.getRunById(first.runId))?.status).toBe("failed");
    });
    const retry = await scheduler.retryRun(first.runId);
    expect((await store.getRunById(retry.runId))?.companyId).toBe(companyA);
  });

  it("cancels stale and active runs without allowing a late completion to overwrite cancellation", async () => {
    const { pluginId, companyA, workspaceJobId } = await seed();
    const store = pluginJobStore(db);
    const run = await store.createRun({ jobId: workspaceJobId, pluginId, trigger: "manual", companyId: companyA });
    await store.markRunning(run.id);
    expect(await store.cancelRun(run.id, "operator cancelled")).toBe(true);
    expect(await store.completeRun(run.id, { status: "succeeded" })).toBe(false);
    expect((await store.getRunById(run.id))?.status).toBe("cancelled");
  });

  it("recovers queued and running records left by a Host restart", async () => {
    const { pluginId, companyA, workspaceJobId } = await seed();
    const store = pluginJobStore(db);
    const queued = await store.createRun({ jobId: workspaceJobId, pluginId, trigger: "manual", companyId: companyA });
    const running = await store.createRun({ jobId: workspaceJobId, pluginId, trigger: "manual", companyId: companyA });
    await store.markRunning(running.id);

    expect(await store.recoverStaleRuns("Host restarted")).toBe(2);
    expect((await store.getRunById(queued.id))?.status).toBe("cancelled");
    expect((await store.getRunById(running.id))?.status).toBe("cancelled");
  });
});
