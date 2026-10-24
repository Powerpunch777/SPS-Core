import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { companies, plugins, type Db } from "../compat/paperclip/db.js";
import { assertCompanyAccess, assertSpsCoreHostAuthority } from "../compat/paperclip/control-plane.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { spsExecutionHistoryService } from "../services/sps-execution-history.js";
import { SpsExecutionSummaryLimitError, validateSpsExecutionSummaryOptions } from "../services/sps-execution-summary.js";
import type { PluginSpsExecutionCursor, PluginSpsExecutionLane } from "../compat/paperclip/plugin-sdk.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isLane = (value: unknown): value is PluginSpsExecutionLane => value === "node" || value === "agent_session";

function readHostScope(req: Request) {
  assertSpsCoreHostAuthority(req);
  const companyId = String(req.params.companyId).toLowerCase();
  if (!uuid.test(companyId)) throw badRequest("Workspace ID must be a UUID");
  assertCompanyAccess(req, companyId);
  const pluginId = req.query.pluginId;
  if (typeof pluginId !== "string" || !uuid.test(pluginId)) throw badRequest("Plugin ID must be a UUID");
  return { companyId, pluginId: pluginId.toLowerCase() };
}

function historyOptions(query: Request["query"]) {
  const allowed = ["pluginId", "limit", "lane", "beforeCreatedAt", "beforeRunId", "beforeLane"];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw badRequest("Unknown execution history query parameter");
  const limit = query.limit === undefined ? 20 : typeof query.limit === "string" && /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isInteger(limit) || limit > 100) throw badRequest("Execution limit must be an integer from 1 to 100");
  if (query.lane !== undefined && !isLane(query.lane)) throw badRequest("Invalid execution lane");
  let before: PluginSpsExecutionCursor | undefined;
  if ([query.beforeCreatedAt, query.beforeRunId, query.beforeLane].some(value => value !== undefined)) {
    const { beforeCreatedAt, beforeRunId, beforeLane } = query;
    if (typeof beforeCreatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(beforeCreatedAt)
      || !Number.isFinite(Date.parse(beforeCreatedAt)) || new Date(beforeCreatedAt).toISOString() !== beforeCreatedAt
      || typeof beforeRunId !== "string" || !uuid.test(beforeRunId) || !isLane(beforeLane)) {
      throw badRequest("Use a complete canonical execution cursor");
    }
    before = { createdAt: beforeCreatedAt, runId: beforeRunId.toLowerCase(), lane: beforeLane };
  }
  return { limit, ...(query.lane === undefined ? {} : { lane: query.lane }), ...(before ? { before } : {}) };
}

/** Human Host diagnostics; never a shortcut around the Plugin capability bridge. */
export function spsExecutionRoutes(db: Db) {
  const router = Router();
  async function historyForScope(companyId: string, pluginId: string) {
    const [workspace] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!workspace) throw notFound("Workspace not found");
    const [plugin] = await db.select({ pluginKey: plugins.pluginKey }).from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    if (!plugin) throw notFound("Plugin not found");
    return spsExecutionHistoryService(db, plugin.pluginKey);
  }
  router.get("/companies/:companyId/sps-executions", async (req, res) => {
    const { companyId, pluginId } = readHostScope(req);
    const options = historyOptions(req.query);
    const history = await historyForScope(companyId, pluginId);
    res.set("Cache-Control", "no-store").json(await history.list(companyId, options));
  });
  router.get("/companies/:companyId/sps-executions/summary", async (req, res) => {
    const { companyId, pluginId } = readHostScope(req);
    if (Object.keys(req.query).some(key => !["pluginId", "from", "to", "lane", "agentId"].includes(key))) {
      throw badRequest("Unknown execution summary query parameter");
    }
    let options;
    try {
      options = validateSpsExecutionSummaryOptions({ from: req.query.from, to: req.query.to,
        ...(req.query.lane === undefined ? {} : { lane: req.query.lane }),
        ...(req.query.agentId === undefined ? {} : { agentId: req.query.agentId }) });
    } catch {
      throw badRequest("Use canonical UTC from/to timestamps within 31 days and valid execution filters");
    }
    // Historical usage remains inspectable after disabling/uninstalling a Plugin.
    // Scope comes from its registry identity, never a caller-supplied pluginKey.
    try {
      const summary = await (await historyForScope(companyId, pluginId)).summarize(companyId, options);
      res.set("Cache-Control", "no-store").json(summary);
    } catch (error) {
      if (error instanceof SpsExecutionSummaryLimitError) throw unprocessable(error.message);
      throw error;
    }
  });
  router.get("/companies/:companyId/sps-executions/:lane/:runId", async (req, res) => {
    const { companyId, pluginId } = readHostScope(req);
    if (Object.keys(req.query).some(key => key !== "pluginId")) throw badRequest("Unknown execution detail query parameter");
    const lane = req.params.lane, runId = String(req.params.runId).toLowerCase();
    if (!isLane(lane) || !uuid.test(runId)) throw badRequest("Use a valid execution lane and run UUID");
    const run = await (await historyForScope(companyId, pluginId)).get(companyId, lane, runId);
    if (!run) throw notFound("Execution not found");
    res.set("Cache-Control", "no-store").json(run);
  });
  return router;
}
