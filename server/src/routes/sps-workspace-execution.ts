import { Router } from "express";
import { z } from "zod/v3";
import { spsWorkspaceExecutionActionSchema, type SpsWorkspaceExecutionAction } from "../compat/paperclip/shared.js";
import type { Db } from "../compat/paperclip/db.js";
import { validate } from "../middleware/validate.js";
import { spsWorkspaceExecutionControlService } from "../services/sps-workspace-execution-control.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, hasSpsCoreHostAuthority } from "./authz.js";

/** Mounted under /companies/:companyId/execution-control. No Agent/Plugin mutation authority. */
export function spsWorkspaceExecutionRoutes(db: Db) {
  const router = Router({ mergeParams: true });
  router.get<{ companyId: string }>("/", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json({ ...await spsWorkspaceExecutionControlService(db).get(companyId), canControl: hasSpsCoreHostAuthority(req) });
  });
  router.post<{ companyId: string }>("/", validate(spsWorkspaceExecutionActionSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const body = req.body as SpsWorkspaceExecutionAction;
    const result = await spsWorkspaceExecutionControlService(db).transition(companyId, body.action,
      req.actor.userId ?? "local-board", body.expectedRevision);
    res.json({ ...result, canControl: true });
  });
  return router;
}
