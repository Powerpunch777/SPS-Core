import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  companies,
  plugins,
  agents,
  projects,
  projectWorkspaces,
  issues,
  agentTaskSessions,
  activityLog,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { publishLiveEvent } from "../services/live-events.js";

// Mock heartbeatService to avoid launching agent processes in this host-service test.
const { mockWakeup } = vi.hoisted(() => ({ mockWakeup: vi.fn() }));

vi.mock("../services/heartbeat.js", () => {
  return {
    heartbeatService: vi.fn().mockImplementation(() => {
      return {
        wakeup: mockWakeup,
      };
    }),
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
    id: "paperclip.session-context-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Session Context Test",
    description: "Test plugin for agent session context",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin agent session context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describePostgres("plugin agent session context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let activeServices: Array<{ dispose(): void }> = [];

  beforeAll(async () => {
    if (externalPostgresUrl) {
      await applyPendingMigrations(externalPostgresUrl);
      db = createDb(externalPostgresUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-session-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockWakeup.mockClear();
    for (const service of activeServices) {
      try {
        service.dispose();
      } catch (err) {
        console.error("Failed to dispose host services:", err);
      }
    }
    activeServices = [];

    // Clean up in FK-safe order: child-first, parent-last
    await db.delete(activityLog);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndPlugin(options: {
    companyId?: string;
    notifyWorker?: (method: string, params: unknown) => void;
  } = {}) {
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
      packageName: "@paperclipai/plugin-session-context-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
      installOrder: 1,
    });

    const services = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), options.notifyWorker, {
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

  it("creates, persists normalized context, and returns it; list returns same context", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Test Workspace",
      sourceType: "local_path",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test Issue",
      status: "todo",
      priority: "medium",
    });

    const context = {
      projectId,
      projectWorkspaceId,
      issueId,
    };

    const session = await services.agentSessions.create({
      agentId,
      companyId,
      context,
    });

    expect(session.context).toEqual(context);
    expect(session.lastRunId).toBeNull();
    expect(session.lastError).toBeNull();

    // Verify it is persisted in DB
    const [dbRow] = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, session.sessionId));
    expect(dbRow?.contextJson).toEqual(context);

    // List should return the same context
    const list = await services.agentSessions.list({
      agentId,
      companyId,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.context).toEqual(context);
    expect(list[0]?.lastRunId).toBeNull();
    expect(list[0]?.lastError).toBeNull();
  });

  it("infers projectId from valid projectWorkspaceId and/or issueId", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Test Workspace",
      sourceType: "local_path",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test Issue",
      status: "todo",
      priority: "medium",
    });

    // 2a. Omit projectId, provide projectWorkspaceId only
    const sessionA = await services.agentSessions.create({
      agentId,
      companyId,
      context: {
        projectWorkspaceId,
      },
    });
    expect(sessionA.context).toEqual({
      projectId,
      projectWorkspaceId,
    });

    // 2b. Omit projectId, provide issueId only
    const sessionB = await services.agentSessions.create({
      agentId,
      companyId,
      context: {
        issueId,
      },
    });
    expect(sessionB.context).toEqual({
      projectId,
      issueId,
    });

    // 2c. Omit projectId, provide both workspace and issue (pointing to same project)
    const sessionC = await services.agentSessions.create({
      agentId,
      companyId,
      context: {
        projectWorkspaceId,
        issueId,
      },
    });
    expect(sessionC.context).toEqual({
      projectId,
      projectWorkspaceId,
      issueId,
    });
  });

  it("rejects cross-company project/workspace/issue IDs without creating a session", async () => {
    const { companyId: companyAId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyAId);

    const companyBId = randomUUID();
    await db.insert(companies).values({
      id: companyBId,
      name: "Company B",
      issuePrefix: issuePrefix(companyBId),
      requireBoardApprovalForNewAgents: false,
    });

    const projectBId = randomUUID();
    const workspaceBId = randomUUID();
    const issueBId = randomUUID();

    await db.insert(projects).values({
      id: projectBId,
      companyId: companyBId,
      name: "Project B",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceBId,
      companyId: companyBId,
      projectId: projectBId,
      name: "Workspace B",
      sourceType: "local_path",
      cwd: "/tmp/workspace-b",
    });
    await db.insert(issues).values({
      id: issueBId,
      companyId: companyBId,
      projectId: projectBId,
      title: "Issue B",
      status: "todo",
      priority: "medium",
    });

    // 3a. Cross-company project
    await expect(
      services.agentSessions.create({
        agentId,
        companyId: companyAId,
        context: { projectId: projectBId },
      })
    ).rejects.toThrow("Project not found");

    // 3b. Cross-company workspace
    await expect(
      services.agentSessions.create({
        agentId,
        companyId: companyAId,
        context: { projectWorkspaceId: workspaceBId },
      })
    ).rejects.toThrow("Project workspace not found");

    // 3c. Cross-company issue
    await expect(
      services.agentSessions.create({
        agentId,
        companyId: companyAId,
        context: { issueId: issueBId },
      })
    ).rejects.toThrow("Issue not found");

    // Verify no sessions were created at all in db
    const rows = await db.select().from(agentTaskSessions);
    expect(rows).toHaveLength(0);
  });

  it("rejects explicit project mismatches with a workspace or issue", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const project1Id = randomUUID();
    const project2Id = randomUUID();
    const workspace1Id = randomUUID();
    const issue1Id = randomUUID();

    await db.insert(projects).values({
      id: project1Id,
      companyId,
      name: "Project 1",
      status: "in_progress",
    });
    await db.insert(projects).values({
      id: project2Id,
      companyId,
      name: "Project 2",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspace1Id,
      companyId,
      projectId: project1Id,
      name: "Workspace 1",
      sourceType: "local_path",
      cwd: "/tmp/workspace-1",
    });
    await db.insert(issues).values({
      id: issue1Id,
      companyId,
      projectId: project1Id,
      title: "Issue 1",
      status: "todo",
      priority: "medium",
    });

    // project2Id mismatch with workspace1Id (which belongs to project1Id)
    await expect(
      services.agentSessions.create({
        agentId,
        companyId,
        context: {
          projectId: project2Id,
          projectWorkspaceId: workspace1Id,
        },
      })
    ).rejects.toThrow("Workspace does not belong to the project");

    await expect(
      services.agentSessions.create({
        agentId,
        companyId,
        context: {
          projectId: project2Id,
          issueId: issue1Id,
        },
      }),
    ).rejects.toThrow("Issue does not belong to the project");

    // Verify no sessions were created in db
    const rows = await db.select().from(agentTaskSessions);
    expect(rows).toHaveLength(0);
  });

  it("rejects workspace and issue from different projects when projectId is omitted", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const project1Id = randomUUID();
    const project2Id = randomUUID();
    const workspace1Id = randomUUID();
    const issue2Id = randomUUID();

    await db.insert(projects).values({
      id: project1Id,
      companyId,
      name: "Project 1",
      status: "in_progress",
    });
    await db.insert(projects).values({
      id: project2Id,
      companyId,
      name: "Project 2",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspace1Id,
      companyId,
      projectId: project1Id,
      name: "Workspace 1",
      sourceType: "local_path",
      cwd: "/tmp/workspace-1",
    });
    await db.insert(issues).values({
      id: issue2Id,
      companyId,
      projectId: project2Id,
      title: "Issue 2",
      status: "todo",
      priority: "medium",
    });

    await expect(
      services.agentSessions.create({
        agentId,
        companyId,
        context: {
          projectWorkspaceId: workspace1Id,
          issueId: issue2Id,
        },
      })
    ).rejects.toThrow("Workspace and issue point to different projects");

    // Verify no sessions were created in db
    const rows = await db.select().from(agentTaskSessions);
    expect(rows).toHaveLength(0);
  });

  it("sendMessage propagates persisted context and wake keys into created heartbeat run contextSnapshot", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Test Workspace",
      sourceType: "local_path",
      cwd: "/tmp/test-workspace",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Test Issue",
      status: "todo",
      priority: "medium",
    });

    const context = {
      projectId,
      projectWorkspaceId,
      issueId,
    };

    const session = await services.agentSessions.create({
      agentId,
      companyId,
      context,
    });

    const mockRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: mockRunId,
      companyId,
      agentId,
      status: "queued",
    });
    mockWakeup.mockResolvedValueOnce({ id: mockRunId });

    const response = await services.agentSessions.sendMessage({
      companyId,
      sessionId: session.sessionId,
      prompt: "Hello Agent",
      reason: "Test reason",
    });

    expect(response).toEqual({ runId: mockRunId });

    expect(mockWakeup).toHaveBeenCalledTimes(1);
    expect(mockWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: "Test reason",
        payload: { prompt: "Hello Agent" },
        contextSnapshot: expect.objectContaining({
          wakeSource: "automation",
          wakeTriggerDetail: "system",
          projectId,
          projectWorkspaceId,
          issueId,
        }),
      })
    );

    const [dbRow] = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, session.sessionId));
    expect(mockWakeup.mock.calls[0]?.[1]?.contextSnapshot?.taskKey).toBe(dbRow?.taskKey);
    expect(mockWakeup.mock.calls[0]?.[1]?.contextSnapshot?.spsPluginConversation).toEqual({
      pluginKey: "paperclip.session-context-test", sessionId: session.sessionId, message: "Hello Agent",
    });
    expect(dbRow?.lastRunId).toBe(mockRunId);
    expect(dbRow?.lastError).toBeNull();
  });

  it("delivers one enriched succeeded terminal event and clears lastError", async () => {
    const notifyWorker = vi.fn();
    const { companyId, services } = await seedCompanyAndPlugin({ notifyWorker });
    const agentId = await seedAgent(companyId);
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    mockWakeup.mockResolvedValueOnce({ id: runId });

    await services.agentSessions.sendMessage({
      companyId,
      sessionId: session.sessionId,
      prompt: "Finish the Room turn",
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        resultJson: { summary: "The Room answer" },
        usageJson: { outputTokens: 12 },
      })
      .where(eq(heartbeatRuns.id, runId));
    const terminalEvent = {
      companyId,
      type: "heartbeat.run.status" as const,
      payload: { runId, agentId, status: "succeeded" },
    };
    publishLiveEvent(terminalEvent);
    publishLiveEvent(terminalEvent);

    await vi.waitFor(() => {
      const terminalCalls = notifyWorker.mock.calls.filter((call) =>
        call[0] === "agents.sessions.event" && (call[1] as any)?.eventType === "done",
      );
      expect(terminalCalls).toHaveLength(1);
      expect((terminalCalls[0]?.[1] as any)?.payload?.resultJson?.summary).toBe("The Room answer");
      expect((terminalCalls[0]?.[1] as any)?.payload?.usageJson?.outputTokens).toBe(12);
    });

    const [dbRow] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId));
    expect(dbRow?.lastRunId).toBe(runId);
    expect(dbRow?.lastError).toBeNull();
  });

  it("synthesizes one enriched error event when the run already failed", async () => {
    const notifyWorker = vi.fn();
    const { companyId, services } = await seedCompanyAndPlugin({ notifyWorker });
    const agentId = await seedAgent(companyId);
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "Quota unavailable",
      errorCode: "adapter_failed",
    });
    mockWakeup.mockResolvedValueOnce({ id: runId });

    await services.agentSessions.sendMessage({
      companyId,
      sessionId: session.sessionId,
      prompt: "Run immediately",
    });

    const terminalCalls = notifyWorker.mock.calls.filter((call) =>
      call[0] === "agents.sessions.event" && (call[1] as any)?.eventType === "error",
    );
    expect(terminalCalls).toHaveLength(1);
    expect((terminalCalls[0]?.[1] as any)?.payload).toMatchObject({
      status: "failed",
      error: "Quota unavailable",
      errorCode: "adapter_failed",
    });
    const [dbRow] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId));
    expect(dbRow?.lastRunId).toBe(runId);
    expect(dbRow?.lastError).toBe("Quota unavailable");
  });

  it("delivers a terminal fallback event when run-result enrichment fails", async () => {
    const notifyWorker = vi.fn();
    const { companyId, services } = await seedCompanyAndPlugin({ notifyWorker });
    const agentId = await seedAgent(companyId);
    const session = await services.agentSessions.create({ agentId, companyId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    mockWakeup.mockResolvedValueOnce({ id: runId });

    await services.agentSessions.sendMessage({
      companyId,
      sessionId: session.sessionId,
      prompt: "Deliver even if enrichment fails",
    });

    const selectSpy = vi.spyOn(db, "select").mockImplementationOnce((() => {
      throw new Error("Simulated terminal enrichment failure");
    }) as any);
    publishLiveEvent({
      companyId,
      type: "heartbeat.run.status",
      payload: {
        runId,
        agentId,
        status: "failed",
        error: "Observed fallback error",
        errorCode: "adapter_failed",
      },
    });

    await vi.waitFor(() => {
      const terminalCalls = notifyWorker.mock.calls.filter((call) =>
        call[0] === "agents.sessions.event" && (call[1] as any)?.eventType === "error",
      );
      expect(terminalCalls).toHaveLength(1);
      expect((terminalCalls[0]?.[1] as any)?.payload).toMatchObject({
        status: "failed",
        resultJson: null,
        error: "Observed fallback error",
        errorCode: "adapter_failed",
      });
    });
    selectSpy.mockRestore();

    const [dbRow] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId));
    expect(dbRow?.lastError).toBe("Observed fallback error");
  });

  it("remains backward compatible storing null context when omitted", async () => {
    const { companyId, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);

    const session = await services.agentSessions.create({
      agentId,
      companyId,
    });

    expect(session.context).toBeUndefined();
    expect(session.lastRunId).toBeNull();
    expect(session.lastError).toBeNull();

    const [dbRow] = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.id, session.sessionId));
    expect(dbRow?.contextJson).toBeNull();

    const list = await services.agentSessions.list({
      agentId,
      companyId,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.context).toBeUndefined();
    expect(list[0]?.lastRunId).toBeNull();
    expect(list[0]?.lastError).toBeNull();
  });
});
