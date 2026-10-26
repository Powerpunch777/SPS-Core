import { Router, type Request } from "express";
import { assertCompanyAccess, assertSpsCoreHostAuthority, logActivity } from "../compat/paperclip/control-plane.js";
import type { Db } from "../compat/paperclip/db.js";
import { createSpsModelConnectionSchema, updateSpsModelConnectionStatusSchema, grantSpsModelConnectionSchema } from "../compat/paperclip/shared.js";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { requireSpsModelId, spsModelConnectionService } from "../services/sps-model-connections.js";

/** Host-only infrastructure settings. Plugins use a separate capability-bound execution bridge. */
export function spsModelConnectionRoutes(db: Db) {
  const router = Router(), service = spsModelConnectionService(db);
  function hostScope(req: Request) {
    assertSpsCoreHostAuthority(req);
    let companyId: string;
    try { companyId = requireSpsModelId(req.params.companyId); } catch { throw badRequest("Invalid Workspace ID"); }
    assertCompanyAccess(req, companyId);
    if (Object.keys(req.query).length > 0) throw badRequest("Unknown model connection query parameter");
    return { companyId, userId: req.actor.userId ?? "local-board" };
  }
  function resourceId(req: Request, key: string) {
    try { return requireSpsModelId(req.params[key]); } catch { throw badRequest("Invalid model resource ID"); }
  }
  router.use(["/companies/:companyId/sps-model-connections", "/companies/:companyId/sps-model-grants"], (req, _res, next) => {
    hostScope(req);
    next();
  });
  async function audit(companyId: string, userId: string, action: string, entityId: string, entityType = "sps_model_connection") {
    // Endpoint/model/Secret refs and request content are deliberately absent from audit details.
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action, entityType, entityId, details: {} });
  }
  router.get("/companies/:companyId/sps-model-connections", async (req, res) => {
    const { companyId } = hostScope(req);
    const rows = await service.listHost(companyId).catch(() => { throw notFound("Workspace is unavailable"); });
    res.set("Cache-Control", "no-store").json(rows);
  });
  router.post("/companies/:companyId/sps-model-connections", validate(createSpsModelConnectionSchema), async (req, res) => {
    const { companyId, userId } = hostScope(req);
    const row = await service.create(companyId, req.body, userId).catch(() => { throw unprocessable("Model connection could not be saved"); });
    await audit(companyId, userId, "sps_model_connection.created", row.id);
    res.status(201).set("Cache-Control", "no-store").json(row);
  });
  router.patch("/companies/:companyId/sps-model-connections/:connectionId", validate(updateSpsModelConnectionStatusSchema), async (req, res) => {
    const { companyId, userId } = hostScope(req), connectionId = resourceId(req, "connectionId");
    const row = await service.setStatus(companyId, connectionId, req.body.status).catch(() => { throw notFound("Model connection is unavailable"); });
    await audit(companyId, userId, "sps_model_connection.status_updated", row.id);
    res.set("Cache-Control", "no-store").json(row);
  });
  router.get("/companies/:companyId/sps-model-connections/:connectionId/grants", async (req, res) => {
    const { companyId } = hostScope(req), connectionId = resourceId(req, "connectionId");
    const rows = await service.listGrants(companyId, connectionId).catch(() => { throw notFound("Model connection is unavailable"); });
    res.set("Cache-Control", "no-store").json(rows);
  });
  router.post("/companies/:companyId/sps-model-connections/:connectionId/grants", validate(grantSpsModelConnectionSchema), async (req, res) => {
    const { companyId, userId } = hostScope(req), connectionId = resourceId(req, "connectionId");
    const grant = await service.grant(companyId, connectionId, req.body.pluginId, userId).catch(() => { throw unprocessable("Model connection could not be approved for this Plugin"); });
    await audit(companyId, userId, "sps_model_connection.granted", connectionId);
    res.status(201).set("Cache-Control", "no-store").json(grant);
  });
  router.post("/companies/:companyId/sps-model-grants/:grantId/revoke", async (req, res) => {
    const { companyId, userId } = hostScope(req), grantId = resourceId(req, "grantId");
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      throw badRequest("Revoke request does not accept fields");
    }
    await service.revoke(companyId, grantId).catch(() => { throw notFound("Model grant is unavailable"); });
    await audit(companyId, userId, "sps_model_connection.revoked", grantId, "sps_model_grant");
    res.status(204).set("Cache-Control", "no-store").end();
  });
  return router;
}
