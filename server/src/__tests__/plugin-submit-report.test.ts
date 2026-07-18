import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  companies,
  plugins,
  agents,
  issues as issuesTable,
  issueComments,
  heartbeatRuns,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { parseIssueReportSummary } from "../services/issue-reports.js";
import * as issuesModule from "../services/issues.js";

// Spy on issueService to allow controlled DB failures for transaction rollback tests
let shouldFailUpdate = false;
const originalIssueService = issuesModule.issueService;
vi.spyOn(issuesModule, "issueService").mockImplementation((db) => {
  const service = originalIssueService(db);
  return {
    ...service,
    update: async (id, data, dbOrTx) => {
      if (shouldFailUpdate) {
        throw new Error("Simulated DB failure");
      }
      return service.update(id, data, dbOrTx);
    },
  };
});

const externalPostgresUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim() || null;
if (externalPostgresUrl) {
  const databaseName = new URL(externalPostgresUrl).pathname.slice(1);
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error("PAPERCLIP_TEST_DATABASE_URL must name a test-only database");
  }
}
const embeddedPostgresSupport = externalPostgresUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

function manifest() {
  return {
    id: "paperclip.submit-report-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Submit Report Test",
    description: "Test plugin for submit report capability",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["issues.report"],
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describe("parseIssueReportSummary", () => {
  it("accepts only substantive terminal reports with an exact first-line heading", () => {
    expect(parseIssueReportSummary(
      "## Paperclip Final Report\nImplementation and verification completed successfully.",
    )).toEqual({
      kind: "final",
      body: "## Paperclip Final Report\nImplementation and verification completed successfully.",
    });
    expect(parseIssueReportSummary(
      "## Paperclip Blocker Report\nThe required provider credential is unavailable.",
    )).toEqual({
      kind: "blocker",
      body: "## Paperclip Blocker Report\nThe required provider credential is unavailable.",
    });

    expect(parseIssueReportSummary("Completed normally.")).toBeNull();
    expect(parseIssueReportSummary("Preface\n## Paperclip Final Report\nCompleted.")).toBeNull();
    expect(parseIssueReportSummary("## Paperclip Final Report\n..")).toBeNull();
    expect(parseIssueReportSummary(null)).toBeNull();
  });
});

describePostgres("plugin issues submitReport", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let activeServices: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    if (externalPostgresUrl) {
      await applyPendingMigrations(externalPostgresUrl);
      db = createDb(externalPostgresUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-submit-report-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    shouldFailUpdate = false;
    for (const service of activeServices) {
      try {
        service.dispose();
      } catch (err) {
        console.error("Failed to dispose host services:", err);
      }
    }
    activeServices = [];

    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issuesTable);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(options: { companyId?: string } = {}) {
    const companyId = options.companyId ?? randomUUID();
    const pluginId = randomUUID();
    const pluginManifest = manifest();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@paperclipai/plugin-submit-report-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });

    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined, {
      manifest: pluginManifest,
    });
    activeServices.push(services);

    return { companyId, pluginId, pluginManifest, services };
  }

  async function seedAgent(companyId: string, agentId = randomUUID()) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function makeRunActiveForIssue(issueId: string, runId: string) {
    await db
      .update(issuesTable)
      .set({ checkoutRunId: runId, executionRunId: runId })
      .where(eq(issuesTable.id, issueId));
  }

  it("submits a final report successfully, transitions status to in_review, and inserts comment", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    const result = await services.issues.submitReport({
      issueId,
      companyId,
      kind: "final",
      body: "## Paperclip Final Report\nSubstantive content here that is not trivial.",
      actorAgentId: agentId,
      actorRunId: runId,
    });

    expect(result.idempotent).toBe(false);
    expect(result.issue.status).toBe("in_review");
    expect(result.comment.body).toContain("## Paperclip Final Report");
    expect(result.comment.createdByRunId).toBe(runId);

    // Verify in DB
    const [dbIssue] = await db.select().from(issuesTable).where(eq(issuesTable.id, issueId));
    expect(dbIssue?.status).toBe("in_review");

    const dbComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(dbComments).toHaveLength(1);
    expect(dbComments[0]?.body).toContain("## Paperclip Final Report");
    expect(dbComments[0]?.createdByRunId).toBe(runId);
  });

  it("submits a blocker report successfully, transitions status to blocked, and inserts comment", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    const result = await services.issues.submitReport({
      issueId,
      companyId,
      kind: "blocker",
      body: "## Paperclip Blocker Report\nBlocker reason details go here.",
      actorAgentId: agentId,
      actorRunId: runId,
    });

    expect(result.idempotent).toBe(false);
    expect(result.issue.status).toBe("blocked");
    expect(result.comment.body).toContain("## Paperclip Blocker Report");

    const [dbIssue] = await db.select().from(issuesTable).where(eq(issuesTable.id, issueId));
    expect(dbIssue?.status).toBe("blocked");
  });

  it("fails validation for incorrect heading or trivial body", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    // Incorrect header
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "Wrong Header\nSubstantive text",
        actorAgentId: agentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("First line must be exactly");

    // Title-only/trivial body
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\n",
        actorAgentId: agentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("Report body must contain content after the header");

    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\n..",
        actorAgentId: agentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("Report body is too short or trivial");
  });

  it("rejects reporting when actorAgentId is not assignee or run/context mismatch", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    // Case 1: Wrong assignee
    const anotherAgentId = await seedAgent(companyId);
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\nValid body text.",
        actorAgentId: anotherAgentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("Actor agent is not the assignee of the issue");

    // Case 2: Run doesn't belong to agent
    const anotherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: anotherRunId,
      companyId,
      agentId: anotherAgentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\nValid body text.",
        actorAgentId: agentId,
        actorRunId: anotherRunId,
      })
    ).rejects.toThrow("Actor run does not belong to the specified company/agent");

    // Case 3: Run context snapshot doesn't match issueId
    const wrongContextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: wrongContextRunId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId: randomUUID() },
    });
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\nValid body text.",
        actorAgentId: agentId,
        actorRunId: wrongContextRunId,
      })
    ).rejects.toThrow("Actor run context snapshot does not match the issue ID");

    // Case 4: A stale run for the same agent and issue cannot finish newer work.
    const staleRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\nValid body text.",
        actorAgentId: agentId,
        actorRunId: staleRunId,
      })
    ).rejects.toThrow("Actor run is not the active issue execution owner");
  });

  it("allows same-kind idempotency and rejects opposite-kind second report", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    // 1st submission
    const result1 = await services.issues.submitReport({
      issueId,
      companyId,
      kind: "final",
      body: "## Paperclip Final Report\nSubstantive content.",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    expect(result1.idempotent).toBe(false);

    // 2nd submission (same-kind retry)
    const result2 = await services.issues.submitReport({
      issueId,
      companyId,
      kind: "final",
      body: "## Paperclip Final Report\nSubstantive content.",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    expect(result2.idempotent).toBe(true);
    expect(result2.comment.id).toBe(result1.comment.id);

    // 3rd submission (opposite-kind retry from same run)
    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "blocker",
        body: "## Paperclip Blocker Report\nBlocker body text.",
        actorAgentId: agentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("An opposite-kind report was already submitted for this run");

    // DB should only have 1 comment
    const dbComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(dbComments).toHaveLength(1);
  });

  it("repairs an in-progress issue when the same run already posted a terminal report comment", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();
    const runId = randomUUID();
    const body = "## Paperclip Final Report\n한글 결과와 산출물을 검증했고 작업을 완료했습니다.";

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Repair terminal report state",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body,
    });

    const result = await services.issues.submitReport({
      issueId,
      companyId,
      kind: "final",
      body,
      actorAgentId: agentId,
      actorRunId: runId,
    });

    expect(result.idempotent).toBe(true);
    expect(result.issue.status).toBe("in_review");
    expect(result.comment.body).toBe(body);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    const [issue] = await db.select().from(issuesTable).where(eq(issuesTable.id, issueId));
    expect(issue?.status).toBe("in_review");
  });

  it("serializes concurrent same-run submissions into one report", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Concurrent report issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    const submit = () => services.issues.submitReport({
      issueId,
      companyId,
      kind: "final" as const,
      body: "## Paperclip Final Report\nConcurrent submission completed with verified output.",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    const results = await Promise.all([submit(), submit()]);

    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.comment.id)).size).toBe(1);
    const dbComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(dbComments).toHaveLength(1);
  });

  it("rolls back transaction and does not persist comment if status update fails", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();

    await db.insert(issuesTable).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "finished",
      contextSnapshot: { issueId },
    });
    await makeRunActiveForIssue(issueId, runId);

    // Enable DB failure simulation
    shouldFailUpdate = true;

    await expect(
      services.issues.submitReport({
        issueId,
        companyId,
        kind: "final",
        body: "## Paperclip Final Report\nValid body text.",
        actorAgentId: agentId,
        actorRunId: runId,
      })
    ).rejects.toThrow("Simulated DB failure");

    // Comment should not be persisted due to transaction rollback
    const dbComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(dbComments).toHaveLength(0);

    // Issue status should remain in_progress
    const [dbIssue] = await db.select().from(issuesTable).where(eq(issuesTable.id, issueId));
    expect(dbIssue?.status).toBe("in_progress");
  });
});
