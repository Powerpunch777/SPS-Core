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
import { preserveSpsSessionCancellationContext } from "../services/sps-agent-session-runs.js";
import { withSpsWorkspaceAgentSessionInvocation } from "../services/sps-workspace-agent-session-invocation.js";
import { publishLiveEvent } from "../services/live-events.js";

// Mock heartbeatService to avoid launching agent processes in this host-service test.
const { mockWakeup, mockCancelRun } = vi.hoisted(() => ({ mockWakeup: vi.fn(), mockCancelRun: vi.fn() }));

vi.mock("../services/heartbeat.js", () => {
  return {
    heartbeatService: vi.fn().mockImplementation(() => {
      return {
        wakeup: mockWakeup,
        cancelRun: mockCancelRun,
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
    mockCancelRun.mockReset();
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
    workspaceScoped?: boolean;
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
      ...(options.workspaceScoped ? { workspaceId: companyId } : {}),
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

  async function seedSessionRun(status = "running") {
    const fixture = await seedCompanyAndPlugin();
    const agentId = await seedAgent(fixture.companyId);
    const session = await fixture.services.agentSessions.create({ agentId, companyId: fixture.companyId });
    const stored = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId)).then(rows => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId, status,
      contextSnapshot: { taskKey: stored.taskKey, spsPluginConversation: { pluginKey: fixture.pluginManifest.id, sessionId: session.sessionId } },
    }).returning().then(rows => rows[0]!);
    return { ...fixture, agentId, session, run, params: { companyId: fixture.companyId, sessionId: session.sessionId, runId: run.id } };
  }

  async function seedScopedSessionRun(status = "running") {
    const fixture = await seedCompanyAndPlugin({ workspaceScoped: true });
    const agentId = await seedAgent(fixture.companyId);
    const session = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.create({ agentId, companyId: fixture.companyId }));
    const taskKey = await db.select({ taskKey: agentTaskSessions.taskKey })
      .from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId)).then(rows => rows[0]!.taskKey);
    const run = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId, status,
      contextSnapshot: { taskKey, spsPluginConversation: { pluginKey: fixture.pluginManifest.id, sessionId: session.sessionId } },
    }).returning().then(rows => rows[0]!);
    return { ...fixture, agentId, session, run, params: { companyId: fixture.companyId, sessionId: session.sessionId, runId: run.id } };
  }

  function inSessionInvocation<T>(
    workspaceId: string,
    pluginId: string,
    action: () => Promise<T>,
    assertCurrent: () => void | Promise<void> = async () => {},
  ) {
    return withSpsWorkspaceAgentSessionInvocation({ workspaceId, pluginId, assertCurrent }, action);
  }

  function sessionOperations(fixture: {
    companyId: string;
    pluginId: string;
    services: ReturnType<typeof buildHostServices>;
    agentId: string;
    session: { sessionId: string };
    run: { id: string };
  }) {
    const { companyId, pluginId, services, agentId, session, run } = fixture;
    const args = {
      create: { agentId, companyId },
      list: { agentId, companyId },
      sendMessage: { sessionId: session.sessionId, companyId, prompt: "scoped message" },
      getRun: { sessionId: session.sessionId, companyId, runId: run.id },
      cancel: { sessionId: session.sessionId, companyId, runId: run.id },
    };
    return {
      args,
      call: {
        create: () => services.agentSessions.create(args.create),
        list: () => services.agentSessions.list(args.list),
        sendMessage: () => services.agentSessions.sendMessage(args.sendMessage),
        getRun: () => services.agentSessions.getRun(args.getRun),
        cancel: () => services.agentSessions.cancel(args.cancel),
      },
      inScope: (method: keyof typeof args, workspaceId = companyId, callerPluginId = pluginId) =>
        inSessionInvocation(workspaceId, callerPluginId, () =>
          (services.agentSessions[method] as (params: typeof args[typeof method]) => Promise<unknown>)(args[method])),
    };
  }

  const scopedSessionMethods = ["create", "list", "sendMessage", "getRun", "cancel"] as const;

  it("exposes bounded Agent configuration without executing or widening the Workspace", async () => {
    const { services, companyId } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    await db.update(agents).set({ adapterConfig: { cwd: "C:/private", token: "private" } }).where(eq(agents.id, agentId));
    expect(await services.agents.describeExecution({ agentId, companyId })).toEqual({ agentId, adapterType: "process", state: "configured",
      adapterRegistration: "registered", executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null });
    await expect(services.agents.describeExecution({ agentId, companyId: randomUUID() })).rejects.toThrow("Agent not found");
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it.each(scopedSessionMethods)("requires a live Workspace Agent Session scope for %s", async method => {
    const fixture = await seedScopedSessionRun();
    const { call } = sessionOperations(fixture);

    await expect(call[method]()).rejects.toThrow();
    if (method === "create") {
      expect(await db.select().from(agentTaskSessions)).toHaveLength(1);
    }
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it.each(scopedSessionMethods)("rejects foreign Workspace and Plugin scopes for %s", async method => {
    const fixture = await seedScopedSessionRun();
    const { args, inScope } = sessionOperations(fixture);
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Workspace",
      issuePrefix: issuePrefix(foreignCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    const foreignArgs = { ...args[method], companyId: foreignCompanyId } as typeof args[typeof method];
    const serviceMethod = fixture.services.agentSessions[method] as (params: typeof foreignArgs) => Promise<unknown>;

    await expect(inSessionInvocation(foreignCompanyId, fixture.pluginId, () => serviceMethod(foreignArgs))).rejects.toThrow();
    await expect(inScope(method, fixture.companyId, randomUUID())).rejects.toThrow();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("round-trips all five session methods in its Workspace and persists the real run", async () => {
    const fixture = await seedCompanyAndPlugin({ workspaceScoped: true });
    const agentId = await seedAgent(fixture.companyId);
    const session = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.create({ agentId, companyId: fixture.companyId,
        taskKey: `plugin:${fixture.pluginManifest.id}:session:roundtrip` }));
    const listed = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.list({ agentId, companyId: fixture.companyId }));
    expect(listed.map(item => item.sessionId)).toContain(session.sessionId);

    mockWakeup.mockImplementationOnce(async (wokenAgentId: string, wake: Record<string, any>) =>
      db.insert(heartbeatRuns).values({
        companyId: fixture.companyId,
        agentId: wokenAgentId,
        status: "running",
        contextSnapshot: wake.contextSnapshot,
      }).returning().then(rows => rows[0]!));
    const sent = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.sendMessage({
        companyId: fixture.companyId,
        sessionId: session.sessionId,
        prompt: "Hello from this Workspace",
      }));
    expect(mockWakeup).toHaveBeenCalledOnce();

    const runState = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.getRun({ companyId: fixture.companyId, sessionId: session.sessionId, runId: sent.runId }));
    expect(runState).toMatchObject({ runId: sent.runId, status: "running", output: { state: "not_ready", text: null } });

    mockCancelRun.mockImplementationOnce(async (runId: string) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    });
    const cancelled = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.cancel({ companyId: fixture.companyId, sessionId: session.sessionId, runId: sent.runId }));
    expect(cancelled).toMatchObject({ status: "cancelled", cancellationRequested: true, termination: "pending" });

    const [storedSession] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId));
    const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sent.runId));
    expect(storedSession?.lastRunId).toBe(sent.runId);
    expect(storedRun?.contextSnapshot).toMatchObject({
      taskKey: storedSession?.taskKey,
      spsPluginConversation: { pluginKey: fixture.pluginManifest.id, sessionId: session.sessionId },
    });
  });

  it("rechecks Workspace authority after the awaited session read and before wakeup", async () => {
    const fixture = await seedScopedSessionRun();
    let assertCalls = 0;
    const assertCurrent = vi.fn(async () => {
      assertCalls += 1;
      if (assertCalls === 3) throw new Error("Workspace invocation was revoked");
    });
    const selectSpy = vi.spyOn(db, "select");

    try {
      await expect(inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
        fixture.services.agentSessions.sendMessage({
          companyId: fixture.companyId,
          sessionId: fixture.session.sessionId,
          prompt: "must not wake after revocation",
        }), assertCurrent)).rejects.toThrow();
      expect(assertCalls).toBeGreaterThanOrEqual(3);
      expect(selectSpy).toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("does not insert a session when Workspace authority is revoked after the Agent read", async () => {
    const fixture = await seedCompanyAndPlugin({ workspaceScoped: true });
    const agentId = await seedAgent(fixture.companyId);
    let assertCalls = 0;
    const assertCurrent = vi.fn(async () => {
      assertCalls += 1;
      // Calls 1 and 2 are invocation/service preflight; call 3 follows the awaited Agent read and precedes insert.
      if (assertCalls === 3) throw new Error("Workspace invocation was revoked after Agent read");
    });

    await expect(inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.create({ agentId, companyId: fixture.companyId }), assertCurrent)).rejects.toThrow();
    expect(assertCalls).toBe(3);
    expect(await db.select().from(agentTaskSessions)).toHaveLength(0);
  });

  it("rolls back a queued cancellation marker if Workspace authority is revoked after the marker write", async () => {
    const fixture = await seedScopedSessionRun("queued");
    let assertCalls = 0;
    const assertCurrent = vi.fn(async () => {
      assertCalls += 1;
      // Calls 1-8 enter and validate the scope/session/run; 9 follows the locked row read;
      // call 10 is immediately after the transaction writes its cancellation marker.
      if (assertCalls === 10) throw new Error("Workspace invocation was revoked after marker write");
    });

    await expect(inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.cancel(fixture.params), assertCurrent)).rejects.toThrow();
    expect(assertCalls).toBe(10);
    const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.run.id));
    expect(storedRun?.status).toBe("queued");
    expect(storedRun?.contextSnapshot).not.toHaveProperty("spsSessionCancellationRequested");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("validates task keys on regular and Workspace Hosts without persisting foreign or malformed keys", async () => {
    const { companyId, pluginId, pluginManifest, services } = await seedCompanyAndPlugin();
    const agentId = await seedAgent(companyId);
    const prefix = `plugin:${pluginManifest.id}:session:`;
    const invalidTaskKeys = [
      `plugin:another-plugin:session:foreign`,
      prefix,
      `${prefix}${"x".repeat(1024)}`,
      `${prefix}before\u0001after`,
      `${prefix}\uD800`,
    ];

    for (const taskKey of invalidTaskKeys) {
      await expect(services.agentSessions.create({ agentId, companyId, taskKey })).rejects.toThrow();
    }
    expect(await db.select().from(agentTaskSessions)).toHaveLength(0);

    const validTaskKey = `${prefix}unicode-한🙂`;
    const session = await services.agentSessions.create({ agentId, companyId, taskKey: validTaskKey });
    const [row] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, session.sessionId));
    expect(row?.taskKey).toBe(validTaskKey);
    expect(row?.taskKey.startsWith(prefix)).toBe(true);
    expect(row?.taskKey.slice(prefix.length)).not.toBe("");
    expect(Buffer.byteLength(row!.taskKey, "utf8")).toBeLessThanOrEqual(1024);

    const scopedServices = buildHostServices(db, pluginId, pluginManifest.id, createEventBusStub(), undefined,
      { manifest: pluginManifest, workspaceId: companyId });
    activeServices.push(scopedServices);
    const foreignKey = "plugin:foreign-plugin:session:workspace-forbidden";
    await expect(inSessionInvocation(companyId, pluginId, () =>
      scopedServices.agentSessions.create({ agentId, companyId, taskKey: foreignKey }))).rejects.toThrow();
    const scopedRows = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
    expect(scopedRows.map(scopedRow => scopedRow.taskKey)).toEqual([validTaskKey]);
  });

  it("returns only a bounded, redacted persisted summary for the exact succeeded session run", async () => {
    const fixture = await seedScopedSessionRun("succeeded");
    const secondSession = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.create({ agentId: fixture.agentId, companyId: fixture.companyId }));
    const secret = "adapter-secret-value";
    const summary = `Answer: {\"apiKey\":\"${secret}\"}`;
    await db.update(heartbeatRuns).set({
      resultJson: { summary },
      stdoutExcerpt: "raw stdout secret",
      stderrExcerpt: "raw stderr secret",
      usageJson: { providerRaw: "raw adapter metadata" },
      sessionIdAfter: "raw-adapter-session-id",
    }).where(eq(heartbeatRuns.id, fixture.run.id));

    const result = await inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.getRun(fixture.params));
    expect(result.output).toMatchObject({ state: "available" });
    if (result.output?.state !== "available") throw new Error("Expected a persisted summary");
    expect(Buffer.byteLength(result.output.text, "utf8")).toBeLessThanOrEqual(65_536);
    expect(result.output.text).toContain("***REDACTED***");
    expect(result.output.text).not.toContain(secret);
    for (const rawField of ["resultJson", "stdoutExcerpt", "stderrExcerpt", "usageJson", "sessionIdAfter"]) {
      expect(result).not.toHaveProperty(rawField);
    }
    for (const rawValue of [secret, "raw stdout secret", "raw stderr secret", "raw adapter metadata", "raw-adapter-session-id"]) {
      expect(JSON.stringify(result)).not.toContain(rawValue);
    }
    await db.update(heartbeatRuns).set({ resultJson: { summary: "x".repeat(70_000) } }).where(eq(heartbeatRuns.id, fixture.run.id));
    await expect(inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.getRun(fixture.params))).resolves.toMatchObject({
      output: { state: "withheld", text: null, reason: "too_large" },
    });
    await expect(inSessionInvocation(fixture.companyId, fixture.pluginId, () =>
      fixture.services.agentSessions.getRun({ ...fixture.params, sessionId: secondSession.sessionId }))).rejects.toThrow();
  });

  it("reads only the exact owned session run, without output, paths or adapter secrets", async () => {
    const { services, params, run, pluginManifest } = await seedSessionRun();
    await db.update(heartbeatRuns).set({ stdoutExcerpt: "private output", resultJson: { apiKey: "secret" } }).where(eq(heartbeatRuns.id, run.id));
    expect(await services.agentSessions.getRun(params)).toMatchObject({ runId: run.id, status: "running", cancellationRequested: false, termination: "not_applicable", errorCode: null, error: null,
      execution: { lane: "agent_session", runId: run.id, companyId: params.companyId, pluginKey: pluginManifest.id, phase: "active", usage: { costUsd: { value: null, provenance: "unavailable" } } } });
    for (const patch of [{ companyId: randomUUID() }, { sessionId: randomUUID() }, { runId: randomUUID() }, { runId: "invalid" }]) {
      await expect(services.agentSessions.getRun({ ...params, ...patch })).rejects.toThrow();
      await expect(services.agentSessions.cancel({ ...params, ...patch })).rejects.toThrow();
    }
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("exposes read-only own-plugin history through Host services after a session is removed", async () => {
    const { services, params, run } = await seedSessionRun();
    const page = await services.sps!.listExecutions(params.companyId, { lane: "agent_session", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ runId: run.id, lane: "agent_session" });
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.id, params.sessionId));
    expect(await services.sps!.getExecution(params.companyId, "agent_session", run.id)).toMatchObject({ runId: run.id });
    expect(await services.sps!.getExecution(randomUUID(), "agent_session", run.id)).toBeNull();
    expect((await services.sps!.listExecutions(randomUUID())).items).toEqual([]);
    const options = { from: new Date(run.createdAt.getTime() - 1).toISOString(), to: new Date(run.createdAt.getTime() + 1).toISOString() };
    expect(await services.sps!.summarizeExecutions(params.companyId, options)).toMatchObject({ executionCount: 1, tokens: { inputTokens: { reported: null, unavailableExecutions: 1 } } });
    expect((await services.sps!.summarizeExecutions(randomUUID(), options)).executionCount).toBe(0);
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it.each(["taskKey", "pluginKey", "sessionId", "agentId"])("rejects mismatched %s on a session run", async field => {
    const { services, params, run } = await seedSessionRun();
    const context = structuredClone(run.contextSnapshot!);
    if (field === "taskKey") context.taskKey = "plugin:other:session:owned";
    else if (field === "agentId") {
      await db.update(heartbeatRuns).set({ agentId: await seedAgent(params.companyId) }).where(eq(heartbeatRuns.id, run.id));
    } else (context.spsPluginConversation as Record<string, unknown>)[field] = "other";
    await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, run.id));
    await expect(services.agentSessions.cancel(params)).rejects.toThrow("Session run not found");
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("cancels queued runs once and keeps repeated cancellation idempotent", async () => {
    const { services, params } = await seedSessionRun("queued");
    mockCancelRun.mockImplementation(async runId => { await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" }).where(eq(heartbeatRuns.id, runId)); });
    const results = await Promise.all([services.agentSessions.cancel(params), services.agentSessions.cancel(params)]);
    expect(results.some(result => result.status === "cancelled" && result.termination === "confirmed")).toBe(true);
    expect(await services.agentSessions.cancel(params)).toMatchObject({ termination: "confirmed" });
    expect(mockCancelRun).toHaveBeenCalledTimes(1);
  });

  it("does not equate a control-plane cancellation with proof of process exit", async () => {
    const { services, params } = await seedSessionRun();
    mockCancelRun.mockImplementation(async runId => { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId)); });
    expect(await services.agentSessions.cancel(params)).toMatchObject({ status: "cancelled", termination: "pending" });
    expect(await services.agentSessions.getRun(params)).toMatchObject({ termination: "pending" });
    await db.update(heartbeatRuns).set({ contextSnapshot: preserveSpsSessionCancellationContext({ taskKey: "stale" }) }).where(eq(heartbeatRuns.id, params.runId));
    const preserved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, params.runId)).then(rows => rows[0]!);
    expect(preserved.contextSnapshot).toMatchObject({ spsSessionCancellationRequested: true, spsSessionCancellationTermination: "pending" });
  });

  it("preserves already-completed runs without a cancellation claim", async () => {
    const { services, params } = await seedSessionRun("succeeded");
    expect(await services.agentSessions.cancel(params)).toMatchObject({ status: "succeeded", cancellationRequested: false, termination: "not_applicable" });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });
  it("resumes a pending cancellation after a control-plane failure", async () => {
    const { services, params } = await seedSessionRun("queued");
    mockCancelRun.mockRejectedValueOnce(new Error("temporary cancellation failure"));
    await expect(services.agentSessions.cancel(params)).rejects.toThrow("temporary");
    mockCancelRun.mockImplementation(async runId => { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId)); });
    expect(await services.agentSessions.cancel(params)).toMatchObject({ status: "cancelled", termination: "confirmed" });
    expect(mockCancelRun).toHaveBeenCalledTimes(2);
  });

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
