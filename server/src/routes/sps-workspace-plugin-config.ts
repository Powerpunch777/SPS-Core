import { Router, type Response } from "express";
import { z } from "zod/v3";
import type { Db } from "../compat/paperclip/db.js";
import { validate } from "../middleware/validate.js";
import { createSpsWorkspacePluginConfigService } from "../services/sps-workspace-plugin-config.js";
import { assertBoard, assertCompanyAccess, assertSpsCoreHostAuthority } from "../compat/paperclip/control-plane.js";

const putBodySchema = z.object({
  configJson: z.record(z.string(), z.unknown()),
  expectedRevision: z.string().uuid().transform(value => value.toLowerCase()).nullable(),
}).strict();

const removeBodySchema = z.object({
  expectedRevision: z.string().uuid().transform(value => value.toLowerCase()).nullable(),
}).strict();

export type SpsWorkspacePluginConfigRouteOptions = {
  invalidate?: (workspaceId: string, pluginId: string, previousRevision: string | null) => Promise<void>;
};

function workspaceAndPlugin(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  const workspaceId = z.string().uuid().parse(req.params.companyId).toLowerCase();
  const pluginId = z.string().uuid().parse(req.params.pluginId).toLowerCase();
  assertCompanyAccess(req, workspaceId);
  assertSpsCoreHostAuthority(req);
  return { workspaceId, pluginId };
}

function mutationUnavailable(res: Response) {
  return res.status(503).json({
    error: "Workspace runtime invalidation is unavailable; configuration was not changed.",
    code: "workspace_runtime_invalidation_unavailable",
  });
}

function restartUnconfirmed(
  res: Response,
  revision: string | null,
) {
  return res.status(503).json({
    error: "Configuration was saved, but the previous Workspace worker has not confirmed termination. Refresh before retrying.",
    code: "workspace_runtime_restart_unconfirmed",
    revision,
  });
}

/** Host-only private settings surface. Mount under `/api` in the SPS app. */
export function spsWorkspacePluginConfigRoutes(db: Db, options: SpsWorkspacePluginConfigRouteOptions = {}) {
  const router = Router();
  router.use("/plugins/:pluginId/companies/:companyId/workspace-runtime-config",
    (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const service = createSpsWorkspacePluginConfigService(db);

  router.get("/plugins/:pluginId/companies/:companyId/workspace-runtime-config", async (req, res) => {
    const { workspaceId, pluginId } = workspaceAndPlugin(req);
    res.json(await service.get(workspaceId, pluginId));
  });

  router.put(
    "/plugins/:pluginId/companies/:companyId/workspace-runtime-config",
    validate(putBodySchema),
    async (req, res) => {
      const { workspaceId, pluginId } = workspaceAndPlugin(req);
      if (!options.invalidate) return mutationUnavailable(res);
      const { configJson, expectedRevision } = req.body as z.infer<typeof putBodySchema>;
      const saved = await service.put({
        workspaceId,
        pluginId,
        configJson,
        expectedRevision,
        actorUserId: req.actor.userId ?? null,
      });
      try {
        await options.invalidate(workspaceId, pluginId, expectedRevision);
      } catch {
        return restartUnconfirmed(res, saved.revision);
      }
      res.json(saved);
    },
  );

  router.delete(
    "/plugins/:pluginId/companies/:companyId/workspace-runtime-config",
    validate(removeBodySchema),
    async (req, res) => {
      const { workspaceId, pluginId } = workspaceAndPlugin(req);
      if (!options.invalidate) return mutationUnavailable(res);
      const { expectedRevision } = req.body as z.infer<typeof removeBodySchema>;
      const saved = await service.remove({
        workspaceId,
        pluginId,
        expectedRevision,
        actorUserId: req.actor.userId ?? null,
      });
      try {
        await options.invalidate(workspaceId, pluginId, expectedRevision);
      } catch {
        return restartUnconfirmed(res, saved.revision);
      }
      res.json(saved);
    },
  );

  return router;
}
