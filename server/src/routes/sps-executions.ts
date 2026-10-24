import { Router } from "express";
import { eq } from "drizzle-orm";
import { companies, plugins, type Db } from "../compat/paperclip/db.js";
import { assertCompanyAccess, assertSpsCoreHostAuthority } from "../compat/paperclip/control-plane.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { spsExecutionHistoryService } from "../services/sps-execution-history.js";
import { SpsExecutionSummaryLimitError, validateSpsExecutionSummaryOptions } from "../services/sps-execution-summary.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Human Host diagnostics; never a shortcut around the Plugin capability bridge. */
export function spsExecutionRoutes(db: Db) {
  const router = Router();
  router.get("/companies/:companyId/sps-executions/summary", async (req, res) => {
    assertSpsCoreHostAuthority(req);
    const companyId = String(req.params.companyId).toLowerCase();
    if (!uuid.test(companyId)) throw badRequest("Workspace ID must be a UUID");
    assertCompanyAccess(req, companyId);
    if (Object.keys(req.query).some(key => !["pluginId", "from", "to", "lane", "agentId"].includes(key))) {
      throw badRequest("Unknown execution summary query parameter");
    }
    const pluginId = req.query.pluginId;
    if (typeof pluginId !== "string" || !uuid.test(pluginId)) throw badRequest("Plugin ID must be a UUID");
    let options;
    try {
      options = validateSpsExecutionSummaryOptions({ from: req.query.from, to: req.query.to,
        ...(req.query.lane === undefined ? {} : { lane: req.query.lane }),
        ...(req.query.agentId === undefined ? {} : { agentId: req.query.agentId }) });
    } catch {
      throw badRequest("Use canonical UTC from/to timestamps within 31 days and valid execution filters");
    }
    const [workspace] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!workspace) throw notFound("Workspace not found");
    const [plugin] = await db.select({ pluginKey: plugins.pluginKey }).from(plugins).where(eq(plugins.id, pluginId.toLowerCase())).limit(1);
    if (!plugin) throw notFound("Plugin not found");
    // Historical usage remains inspectable after disabling/uninstalling a Plugin.
    // Scope comes from its registry identity, never a caller-supplied pluginKey.
    try {
      const summary = await spsExecutionHistoryService(db, plugin.pluginKey).summarize(companyId, options);
      res.set("Cache-Control", "no-store").json(summary);
    } catch (error) {
      if (error instanceof SpsExecutionSummaryLimitError) throw unprocessable(error.message);
      throw error;
    }
  });
  return router;
}
