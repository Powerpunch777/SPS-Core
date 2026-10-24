import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { spsExecutionRoutes } from "../routes/sps-executions.js";
import { SpsExecutionSummaryLimitError } from "../services/sps-execution-summary.js";

const mocks = vi.hoisted(() => ({ summarize: vi.fn(), history: vi.fn() }));
vi.mock("../services/sps-execution-history.js", () => ({
  spsExecutionHistoryService: mocks.history,
}));
const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "22222222-2222-4222-8222-222222222222";
const from = "2026-10-01T00:00:00.000Z", to = "2026-10-02T00:00:00.000Z";
const token = "execution-route-test-token";
const host = { type: "board", source: "session", userId: "host", companyIds: [companyId], isInstanceAdmin: true };
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
function proof(test: request.Test) {
  return test.set("Host", "127.0.0.1").set("x-sps-desktop-access", token).set("x-sps-desktop-owner-bootstrap", token);
}

describe("SPS Host execution usage endpoint", () => {
  beforeEach(() => {
    process.env.SPS_CORE_BASELINE_MODE = "1";
    process.env.SPS_DESKTOP_ACCESS_TOKEN = token;
    mocks.history.mockReturnValue({ summarize: mocks.summarize });
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
});
