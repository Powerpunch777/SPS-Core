import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { spsExecutionRoutes } from "../routes/sps-executions.js";
import { SpsExecutionSummaryLimitError } from "../services/sps-execution-summary.js";

const mocks = vi.hoisted(() => ({ summarize: vi.fn(), list: vi.fn(), get: vi.fn(), history: vi.fn() }));
vi.mock("../services/sps-execution-history.js", () => ({
  spsExecutionHistoryService: mocks.history,
}));
const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const from = "2026-10-01T00:00:00.000Z", to = "2026-10-02T00:00:00.000Z";
const cursor = { createdAt: "2026-10-01T12:34:56.789Z", runId, lane: "agent_session" as const };
const token = "execution-route-test-token";
const host = { type: "board", source: "session", userId: "host", companyIds: [companyId], isInstanceAdmin: true };
const execution = {
  lane: "node",
  runId,
  companyId,
  pluginKey: "io.sps.example",
  agentId: null,
  sessionId: null,
  subjectKey: "worker",
  runtime: { kind: "claude_cli", model: "claude-test", modelSource: "reported" },
  status: "failed",
  phase: "failed",
  cancellationRequested: false,
  termination: "confirmed",
  failure: { category: "timeout", code: null, retrySafety: "requires_review" },
  createdAt: cursor.createdAt,
  startedAt: cursor.createdAt,
  finishedAt: "2026-10-01T12:35:56.789Z",
  elapsedMs: 60_000,
  usage: {
    inputTokens: { value: 12, provenance: "reported" },
    cachedInputTokens: { value: null, provenance: "unavailable" },
    outputTokens: { value: 4, provenance: "reported" },
    costUsd: { value: null, provenance: "unavailable" },
    currency: null,
    billingType: "unknown",
    costBasis: "unknown",
  },
};
const executionPage = { items: [execution], nextCursor: cursor };
const originalMode = process.env.SPS_CORE_BASELINE_MODE;
const originalToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;

function appFor(actor: unknown = host, rows: unknown[][] = [[{ id: companyId }], [{ pluginKey: "io.sps.example" }]]) {
  const limit = vi.fn(async () => rows.shift() ?? []);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  const app = express();
  app.use((req, _res, next) => { Object.assign(req, { actor }); next(); });
  app.use("/api", spsExecutionRoutes({ select } as unknown as Db));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal error" });
  });
  return { app, select };
}
function get(app: express.Express, query: Record<string, unknown> = { pluginId, from, to }, workspace = companyId) {
  return request(app).get(`/api/companies/${workspace}/sps-executions/summary`).query(query);
}
function getList(app: express.Express, query: Record<string, unknown> = { pluginId }, workspace = companyId) {
  return request(app).get(`/api/companies/${workspace}/sps-executions`).query(query);
}
function getDetail(
  app: express.Express,
  lane = "node",
  executionId = runId,
  query: Record<string, unknown> = { pluginId },
  workspace = companyId,
) {
  return request(app).get(`/api/companies/${workspace}/sps-executions/${lane}/${executionId}`).query(query);
}
function proof(test: request.Test) {
  return test.set("Host", "127.0.0.1").set("x-sps-desktop-access", token).set("x-sps-desktop-owner-bootstrap", token);
}

describe("SPS Host execution usage endpoint", () => {
  beforeEach(() => {
    process.env.SPS_CORE_BASELINE_MODE = "1";
    process.env.SPS_DESKTOP_ACCESS_TOKEN = token;
    mocks.history.mockReset().mockReturnValue({ list: mocks.list, get: mocks.get, summarize: mocks.summarize });
    mocks.list.mockReset().mockResolvedValue(executionPage);
    mocks.get.mockReset().mockResolvedValue(execution);
    mocks.summarize.mockReset();
    mocks.summarize.mockResolvedValue({ companyId, pluginKey: "io.sps.example", executionCount: 0 });
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
    else process.env.SPS_CORE_BASELINE_MODE = originalMode;
    if (originalToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalToken;
    vi.clearAllMocks();
  });
  it("requires local Host proof even for a legacy admin and never runs queries on denial", async () => {
    const { app, select } = appFor();
    await get(app).expect(403);
    await get(app).set("x-sps-desktop-access", token).expect(403);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it.each([
    { type: "none" },
    { type: "agent", companyId, agentId: pluginId },
    { ...host, isInstanceAdmin: false },
  ])("rejects unauthenticated/Agent/remote Member actors (%j)", async actor => {
    const { app, select } = appFor(actor);
    await get(app).expect(403);
    expect(select).not.toHaveBeenCalled();
  });
  it("requires Workspace membership even with valid local Host proof", async () => {
    const { app, select } = appFor({ ...host, companyIds: [] });
    await proof(get(app)).expect(403);
    expect(select).not.toHaveBeenCalled();
  });
  it("resolves Plugin scope from the registry, forwards only safe options and disables caching", async () => {
    const { app } = appFor();
    const response = await proof(get(app, { pluginId: pluginId.toUpperCase(), from, to, lane: "agent_session", agentId: companyId })).expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), "io.sps.example");
    expect(mocks.summarize).toHaveBeenCalledWith(companyId, { from, to, lane: "agent_session", agentId: companyId });
  });
  it("supports historical reads without requiring plugin activation or worker startup", async () => {
    const { app } = appFor();
    await proof(get(app)).expect(200);
    await proof(get(appFor().app)).expect(200);
    expect(mocks.summarize).toHaveBeenCalledTimes(2);
  });
  it.each([
    {}, { pluginId, from }, { pluginId: "unknown", from, to },
    { pluginId: [pluginId, pluginId], from, to },
    { pluginId, from: [from, from], to }, { pluginId, from, to, lane: ["node", "agent_session"] },
    { pluginId, from: "2026-10-01", to }, { pluginId, from, to: from },
    { pluginId, from, to: "2026-11-02T00:00:00.000Z" },
    { pluginId, from, to, pluginKey: "another" }, { pluginId, from, to, companyId },
    { pluginId, from, to, lane: "other" }, { pluginId, from, to, agentId: "other" },
    { pluginId, from, to, lane: "node", agentId: companyId },
  ])("rejects ambiguous/unbounded queries without reading executions (%j)", async query => {
    const { app, select } = appFor();
    await proof(get(app, query)).expect(400);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("rejects malformed Workspace identifiers before touching storage", async () => {
    const { app, select } = appFor();
    await proof(get(app, { pluginId, from, to }, "not-a-uuid")).expect(400);
    expect(select).not.toHaveBeenCalled();
  });
  it.each([{ rows: [[], []] }, { rows: [[{ id: companyId }], []] }])("returns 404 for an absent Workspace or Plugin", async ({ rows }) => {
    const { app } = appFor(host, rows);
    await proof(get(app)).expect(404);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("returns an actionable 422 for the bounded aggregation limit, never partial totals", async () => {
    mocks.summarize.mockRejectedValueOnce(new SpsExecutionSummaryLimitError());
    const response = await proof(get(appFor().app)).expect(422);
    expect(response.body.error).toContain("narrow the time window");
    expect(response.body.executionCount).toBeUndefined();
  });
  it("does not relabel infrastructure failures as valid empty data or invalid user input", async () => {
    mocks.summarize.mockRejectedValueOnce(new Error("Database unavailable"));
    await proof(get(appFor().app)).expect(500);
  });

  it.each(["list", "detail"] as const)("requires complete local Host proof for %s reads", async endpoint => {
    const { app, select } = appFor();
    const read = (target: express.Express) => endpoint === "list" ? getList(target) : getDetail(target);
    await read(app).expect(403);
    await read(app).set("Host", "127.0.0.1").set("x-sps-desktop-access", token).expect(403);
    await read(app).set("Host", "127.0.0.1").set("x-sps-desktop-owner-bootstrap", token).expect(403);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", { type: "none" }],
    ["Agent", { type: "agent", companyId, agentId: pluginId }],
    ["remote Member", { type: "board", source: "session", userId: "member", companyIds: [companyId], isInstanceAdmin: false }],
  ])("rejects %s actors for list and detail reads", async (_label, actor) => {
    for (const endpoint of ["list", "detail"] as const) {
      const { app, select } = appFor(actor);
      const response = endpoint === "list" ? getList(app) : getDetail(app);
      await response.expect(403);
      expect(select).not.toHaveBeenCalled();
      expect(mocks.history).not.toHaveBeenCalled();
    }
  });

  it.each(["list", "detail"] as const)("requires Workspace membership for %s reads", async endpoint => {
    const { app, select } = appFor({ ...host, companyIds: [] });
    const response = endpoint === "list" ? getList(app) : getDetail(app);
    await proof(response).expect(403);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("returns a safe paged list scoped by the Plugin registry with a canonical cursor", async () => {
    const { app } = appFor();
    const response = await proof(getList(app, {
      pluginId: pluginId.toUpperCase(),
      limit: "3",
      lane: "agent_session",
      beforeCreatedAt: cursor.createdAt,
      beforeRunId: cursor.runId,
      beforeLane: cursor.lane,
    })).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(executionPage);
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), "io.sps.example");
    expect(mocks.list).toHaveBeenCalledWith(companyId, { limit: 3, lane: "agent_session", before: cursor });
  });

  it("uses the HTTP default list limit of 20 and omits absent filters", async () => {
    const { app } = appFor();
    await proof(getList(app)).expect(200);
    expect(mocks.list).toHaveBeenCalledWith(companyId, { limit: 20 });
  });

  it("returns a safe detail projection scoped by registry, lane, Workspace, and run", async () => {
    const { app } = appFor();
    const response = await proof(getDetail(app, "node", runId, { pluginId: pluginId.toUpperCase() })).expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(execution);
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), "io.sps.example");
    expect(mocks.get).toHaveBeenCalledWith(companyId, "node", runId);
  });

  it.each(["list", "detail"] as const)("keeps historical %s reads available without activation or worker state", async endpoint => {
    const { app, select } = appFor();
    const response = endpoint === "list" ? getList(app) : getDetail(app);
    await proof(response).expect(200);
    expect(select).toHaveBeenCalledTimes(2);
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), "io.sps.example");
    expect(endpoint === "list" ? mocks.list : mocks.get).toHaveBeenCalled();
  });

  it.each([
    ["missing Plugin ID", {}],
    ["invalid Plugin ID", { pluginId: "not-a-uuid" }],
    ["repeated Plugin ID", { pluginId: [pluginId, pluginId] }],
    ["array limit", { pluginId, limit: ["1", "2"] }],
    ["noncanonical integer limit", { pluginId, limit: "01" }],
    ["fractional limit", { pluginId, limit: "1.5" }],
    ["zero limit", { pluginId, limit: "0" }],
    ["over-limit page size", { pluginId, limit: "101" }],
    ["nonnumeric limit", { pluginId, limit: "many" }],
    ["repeated lane", { pluginId, lane: ["node", "agent_session"] }],
    ["unknown query key", { pluginId, debug: "true" }],
    ["partial timestamp cursor", { pluginId, beforeCreatedAt: cursor.createdAt }],
    ["partial UUID cursor", { pluginId, beforeRunId: runId }],
    ["partial lane cursor", { pluginId, beforeLane: "node" }],
    ["partial cursor pair", { pluginId, beforeCreatedAt: cursor.createdAt, beforeRunId: runId }],
    ["noncanonical cursor timestamp", { pluginId, beforeCreatedAt: "2026-10-01T12:34:56Z", beforeRunId: runId, beforeLane: "node" }],
    ["impossible cursor date", { pluginId, beforeCreatedAt: "2026-02-30T12:34:56.789Z", beforeRunId: runId, beforeLane: "node" }],
    ["invalid cursor UUID", { pluginId, beforeCreatedAt: cursor.createdAt, beforeRunId: "bad", beforeLane: "node" }],
    ["invalid cursor lane", { pluginId, beforeCreatedAt: cursor.createdAt, beforeRunId: runId, beforeLane: "other" }],
    ["repeated cursor timestamp", { pluginId, beforeCreatedAt: [cursor.createdAt, cursor.createdAt], beforeRunId: runId, beforeLane: "node" }],
    ["invalid lane filter", { pluginId, lane: "other" }],
  ])("rejects %s list query before reading history", async (_label, query) => {
    const { app, select } = appFor();
    await proof(getList(app, query)).expect(400);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Plugin ID", {}],
    ["invalid Plugin ID", { pluginId: "not-a-uuid" }],
    ["repeated Plugin ID", { pluginId: [pluginId, pluginId] }],
    ["unknown query key", { pluginId, limit: "1" }],
  ])("rejects %s detail query before reading history", async (_label, query) => {
    const { app, select } = appFor();
    await proof(getDetail(app, "node", runId, query)).expect(400);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid lane", "worker", runId],
    ["invalid run UUID", "node", "not-a-uuid"],
  ])("rejects %s detail path before reading history", async (_label, lane, executionId) => {
    const { app, select } = appFor();
    await proof(getDetail(app, lane, executionId)).expect(400);
    expect(select).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each(["list", "detail"] as const)("returns 404 for an absent Workspace or Plugin on %s", async endpoint => {
    for (const rows of [[[], []], [[{ id: companyId }], []]] as unknown[][][]) {
      const { app } = appFor(host, rows);
      const response = endpoint === "list" ? getList(app) : getDetail(app);
      await proof(response).expect(404);
      expect(mocks.history).not.toHaveBeenCalled();
    }
  });

  it("returns 404 rather than an empty detail when the execution is absent", async () => {
    mocks.get.mockResolvedValueOnce(null);
    const { app } = appFor();
    await proof(getDetail(app)).expect(404);
    expect(mocks.history).toHaveBeenCalledWith(expect.anything(), "io.sps.example");
    expect(mocks.get).toHaveBeenCalledWith(companyId, "node", runId);
  });

  it("returns 400 for malformed Workspace and run identifiers before storage access", async () => {
    const { app, select } = appFor();
    await proof(getList(app, { pluginId }, "not-a-uuid")).expect(400);
    await proof(getDetail(app, "node", "not-a-uuid")).expect(400);
    expect(select).not.toHaveBeenCalled();
  });

  it("does not return empty pages or null details for infrastructure errors", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Database unavailable"));
    const { app: listApp } = appFor();
    const listResponse = await proof(getList(listApp)).expect(500);
    expect(listResponse.body.items).toBeUndefined();
    expect(listResponse.body.nextCursor).toBeUndefined();

    mocks.get.mockRejectedValueOnce(new Error("Database unavailable"));
    const { app: detailApp } = appFor();
    const detailResponse = await proof(getDetail(detailApp)).expect(500);
    expect(detailResponse.body).not.toBeNull();
    expect(detailResponse.body).not.toEqual(execution);
  });
});
