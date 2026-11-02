import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";

const ids = {
  company: "a2222222-2222-4222-8222-222222222222",
  otherCompany: "b3333333-3333-4333-8333-333333333333",
  agent: "c4444444-4444-4444-8444-444444444444",
  run: "d5555555-5555-4555-8555-555555555555",
  changedRun: "b9999999-9999-4999-8999-999999999999",
  session: "e8888888-8888-4888-8888-888888888888",
  changedSession: "a9999999-9999-4999-8999-999999999999",
  plugin: "f1111111-1111-4111-8111-111111111111",
};
const pluginKey = "sps.example";
const taskKey = `plugin:${pluginKey}:session:conversation`;

const mocks = vi.hoisted(() => ({
  registry: { getById: vi.fn(), getCompanySettings: vi.fn(), listInstalled: vi.fn() },
  lifecycle: { load: vi.fn(), upgrade: vi.fn(), unload: vi.fn(), enable: vi.fn(), disable: vi.fn() },
  access: { canUser: vi.fn(), hasPermission: vi.fn(), getMembership: vi.fn() },
  toolAccess: { isAllowed: vi.fn(), record: vi.fn() },
  surfaces: { deleteInboxSummariesBySourcePluginKey: vi.fn() },
}));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mocks.registry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => mocks.lifecycle }));
vi.mock("../services/access.js", () => ({ accessService: () => mocks.access }));
vi.mock("../services/plugin-tool-access.js", () => ({
  createPluginToolAccessService: () => mocks.toolAccess,
  pluginRequiresExplicitToolGrant: () => false,
}));
vi.mock("../services/sps-workspace-surfaces.js", () => ({ spsWorkspaceSurfaceService: () => mocks.surfaces }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const pluginRecord = () => ({
  id: ids.plugin,
  pluginKey,
  version: "1.0.0",
  status: "ready",
  manifestJson: { id: pluginKey, companyActivation: { defaultEnabled: true }, entrypoints: { workspaceWorker: "./workspace.js" } },
});
const registeredTool = () => ({
  pluginId: pluginKey,
  pluginDbId: ids.plugin,
  name: "write",
  namespacedName: `${pluginKey}:write`,
  displayName: "Write",
  description: "Write a record",
  parametersSchema: { type: "object" },
  source: "manifest" as const,
});
const agentActor = () => ({ type: "agent", source: "agent_jwt", agentId: ids.agent, companyId: ids.company, runId: ids.run });

function activeRows(overrides: {
  pluginKey?: string;
  runStatus?: string;
  cancelled?: boolean;
  sessionStatus?: string;
  closedAt?: Date | null;
  sessionId?: string;
} = {}) {
  const sessionId = overrides.sessionId ?? ids.session;
  return [
    [{ companyId: ids.company, status: "running" }],
    [{ companyId: ids.company, agentId: ids.agent, status: overrides.runStatus ?? "running", contextSnapshot: {
      taskKey,
      ...(overrides.cancelled ? { spsSessionCancellationRequested: true } : {}),
      spsPluginConversation: { pluginKey: overrides.pluginKey ?? pluginKey, sessionId, message: "workspace tool request" },
    } }],
    [{ id: sessionId, companyId: ids.company, agentId: ids.agent, taskKey, status: overrides.sessionStatus ?? "active", closedAt: overrides.closedAt ?? null }],
  ];
}

function fakeDb(rows: Array<Array<Record<string, unknown>>>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows.shift() ?? [])) })) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })),
  };
}

async function createApp(options: {
  rows?: Array<Array<Record<string, unknown>>>;
  actor?: ReturnType<typeof agentActor>;
  workspaceCall?: (args: unknown[], authority: { assertCurrent(): Promise<void> }) => Promise<unknown>;
  workerUnavailable?: boolean;
  getTool?: () => ReturnType<typeof registeredTool> | undefined;
} = {}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"), import("../middleware/index.js"),
  ]);
  const legacyExecute = vi.fn(async () => ({ content: "legacy" }));
  const getTool = vi.fn(options.getTool ?? registeredTool);
  const authorityCheck = vi.fn(async (authority: { assertCurrent(): Promise<void> }) => authority.assertCurrent());
  const workspaceCall = vi.fn(async (...args: unknown[]) => {
    const authority = args[5] as { assertCurrent(): Promise<void> };
    await authorityCheck(authority);
    const checkedAuthority = { assertCurrent: () => authorityCheck(authority) };
    return options.workspaceCall ? options.workspaceCall(args, checkedAuthority) : { content: "workspace" };
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = (options.actor ?? agentActor()) as typeof req.actor; next(); });
  app.use("/api", pluginRoutes(
    fakeDb(options.rows ?? activeRows()) as never,
    { installPlugin: vi.fn() } as never, undefined, undefined,
    { toolDispatcher: { listToolsForAgent: vi.fn(), getTool, executeTool: legacyExecute } } as never,
    options.workerUnavailable ? {} as never : { workspaceWorkers: { call: workspaceCall } } as never,
  ));
  app.use(errorHandler);
  return { app, workspaceCall, legacyExecute, getTool, authorityCheck };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    tool: `${pluginKey}:write`,
    parameters: { value: "ok" },
    runContext: { agentId: ids.agent, runId: ids.run, companyId: ids.company, sessionId: "forged-session", role: "admin", ...overrides },
  };
}

describe("Workspace plugin tool route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registry.getById.mockImplementation(async () => pluginRecord());
    mocks.registry.getCompanySettings.mockResolvedValue(null);
    mocks.registry.listInstalled.mockImplementation(async () => [pluginRecord()]);
    mocks.toolAccess.isAllowed.mockResolvedValue(true);
    mocks.toolAccess.record.mockResolvedValue(undefined);
  });

  it("uses a DB-verified projectless active session, ignoring body session and role", async () => {
    const { app, workspaceCall, legacyExecute } = await createApp({ rows: [...activeRows(), ...activeRows()] });
    const response = await request(app).post("/api/plugins/tools/execute").send(body());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(workspaceCall).toHaveBeenCalledWith(ids.company, ids.plugin, "executeTool", {
      toolName: "write",
      parameters: { value: "ok" },
      runContext: expect.objectContaining({ agentId: ids.agent, runId: ids.run, companyId: ids.company, sessionId: ids.session }),
    }, 30_000, expect.objectContaining({ assertCurrent: expect.any(Function) }));
    const payload = workspaceCall.mock.calls[0][3] as { runContext: Record<string, unknown> };
    const context = payload.runContext;
    expect(Object.isFrozen(context)).toBe(true);
    expect(context).not.toHaveProperty("role");
    expect(legacyExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["board", { type: "board", source: "session", companyIds: [ids.company] }, activeRows()],
    ["agent_key", { ...agentActor(), source: "agent_key" }, activeRows()],
    ["missing run", agentActor(), [[{ companyId: ids.company, status: "running" }], []]],
    ["cross workspace", agentActor(), activeRows()],
    ["cross plugin", agentActor(), activeRows({ pluginKey: "sps.other" })],
    ["cancelled run", agentActor(), activeRows({ cancelled: true })],
    ["closed session", agentActor(), activeRows({ sessionStatus: "closed", closedAt: new Date() })],
  ])("denies %s before worker dispatch", async (label, actor, rows) => {
    const { app, workspaceCall, legacyExecute } = await createApp({ actor, rows });
    const response = await request(app).post("/api/plugins/tools/execute").send(body({
      ...(label === "cross workspace" ? { companyId: ids.otherCompany } : {}),
    }));
    expect(response.status).toBe(403);
    expect(workspaceCall).not.toHaveBeenCalled();
    expect(legacyExecute).not.toHaveBeenCalled();
  });

  it("fails closed when the Workspace worker is unavailable, without legacy dispatch", async () => {
    const { app, legacyExecute } = await createApp({ rows: [...activeRows(), ...activeRows()], workerUnavailable: true });
    const response = await request(app).post("/api/plugins/tools/execute").send(body());
    expect(response.status, JSON.stringify(response.body)).toBe(502);
    expect(legacyExecute).not.toHaveBeenCalled();
  });

  it.each(["cancelled run", "grant removed", "plugin deactivated", "registration changed", "session changed", "Agent run changed"])(
    "rechecks %s after worker admission and before its write", async (change) => {
      const workerEntered = vi.fn();
      const write = vi.fn();
      const initial = activeRows();
      const actor = agentActor();
      const changed = change === "cancelled run"
        ? activeRows({ cancelled: true })
        : change === "session changed" ? activeRows({ sessionId: ids.changedSession }) : activeRows();
      const rows = change === "Agent run changed" ? [...initial, ...initial] : [...initial, ...initial, ...changed];
      if (change === "grant removed") mocks.toolAccess.isAllowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      if (change === "plugin deactivated") mocks.registry.getCompanySettings
        .mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ enabled: false });
      const { app, authorityCheck } = await createApp({
        rows,
        actor,
        getTool: change === "registration changed"
          ? vi.fn().mockReturnValueOnce(registeredTool()).mockReturnValueOnce(registeredTool()).mockReturnValueOnce(undefined)
          : undefined,
        workspaceCall: async (_args, authority) => {
          workerEntered();
          expect(authorityCheck).toHaveBeenCalledTimes(1);
          if (change === "Agent run changed") actor.runId = ids.changedRun;
          await authority.assertCurrent();
          write();
          return { content: "written" };
        },
      });
      const response = await request(app).post("/api/plugins/tools/execute").send(body());
      expect(response.status).toBe(403);
      expect(workerEntered).toHaveBeenCalledOnce();
      expect(authorityCheck).toHaveBeenCalledTimes(2);
      expect(write).not.toHaveBeenCalled();
      expect(mocks.toolAccess.record).toHaveBeenCalledTimes(1);
      expect(mocks.toolAccess.record).toHaveBeenCalledWith(expect.objectContaining({
        companyId: ids.company,
        pluginId: ids.plugin,
        agentId: ids.agent,
        runId: ids.run,
        toolName: `${pluginKey}:write`,
        status: "denied",
        errorCode: "PLUGIN_TOOL_EXECUTION_FAILED",
      }));
    },
  );

  it("audits manager scope denials and hides the raw JsonRpcCallError", async () => {
    const rawMessage = "private authority diagnostic";
    const { app, legacyExecute } = await createApp({
      rows: [...activeRows(), ...activeRows()],
      workspaceCall: async () => {
        throw new JsonRpcCallError({ code: -32005, message: rawMessage });
      },
    });
    const response = await request(app).post("/api/plugins/tools/execute").send(body());

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Plugin tool invocation authority is no longer current." });
    expect(response.text).not.toContain(rawMessage);
    expect(mocks.toolAccess.record).toHaveBeenCalledTimes(1);
    expect(mocks.toolAccess.record).toHaveBeenCalledWith(expect.objectContaining({
      status: "denied",
      errorCode: "PLUGIN_TOOL_EXECUTION_FAILED",
      toolName: `${pluginKey}:write`,
    }));
    expect(legacyExecute).not.toHaveBeenCalled();
  });

  it("does not permit mutations of the worker context to rewrite its verified identity", async () => {
    const { app, workspaceCall } = await createApp({ rows: [...activeRows(), ...activeRows()] });
    await request(app).post("/api/plugins/tools/execute").send(body());
    const payload = workspaceCall.mock.calls[0][3] as { runContext: Record<string, unknown> };
    const context = payload.runContext;
    expect(() => { context.agentId = ids.otherCompany; }).toThrow();
    expect(context.agentId).toBe(ids.agent);
  });
});
