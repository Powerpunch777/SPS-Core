import { Router, type Request } from "express";
import type { Db } from "../compat/paperclip/db.js";
import { createSpsMemberDeviceRequestSchema } from "../compat/paperclip/shared.js";
import { assertCompanyAccess } from "../compat/paperclip/control-plane.js";
import { badRequest, forbidden, HttpError } from "../errors.js";
import { hasTrustedDesktopOwnerBootstrap } from "../middleware/desktop-local-access.js";
import { validate } from "../middleware/validate.js";
import { spsMemberDeviceService, SpsMemberDeviceError, type SpsMemberDeviceHostAuthority } from "../services/sps-member-devices.js";
import type { SpsNativeHostManagement } from "../services/sps-native-host-management.js";

type Options = {
  hostId: string;
  onRevoked?: (deviceId: string) => void | Promise<void>;
  management?: SpsNativeHostManagement;
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Host identity comes from trusted configuration, never from request data. */
export function spsMemberDeviceRoutes(db: Db, options: Options) {
  const router = Router();
  const service = spsMemberDeviceService(db, options.hostId);
  const authorities = new WeakMap<Request, SpsMemberDeviceHostAuthority>();
  if (options.management && options.management.hostId !== options.hostId) throw new TypeError("Native Host management binding mismatch.");

  function user(req: Request) {
    if (req.actor.type !== "board" || req.actor.source !== "session"
      || !req.actor.userId || req.actor.userId.length > 200) {
      throw forbidden("SPS Member device management requires a signed-in user session");
    }
    if (Object.keys(req.query).length > 0) throw badRequest("Unknown Member device query parameter");
    return req.actor.userId;
  }
  function host(req: Request) {
    const userId = user(req);
    if (!hasTrustedDesktopOwnerBootstrap(req)) throw forbidden("Only the local SPS Host may approve or manage Member devices");
    return userId;
  }
  function id(req: Request, name: string) {
    const value = req.params[name];
    if (typeof value !== "string" || !uuid.test(value)) throw badRequest("Invalid Member device resource ID");
    return value.toLowerCase();
  }
  function ownScope(req: Request) {
    const userId = user(req), companyId = id(req, "companyId");
    assertCompanyAccess(req, companyId);
    return { userId, companyId };
  }
  function empty(req: Request) {
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object"
      || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      throw badRequest("This Member device action does not accept fields");
    }
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof SpsMemberDeviceError) throw new HttpError(error.status, error.message);
      throw new HttpError(503, "SPS Member device state is unavailable");
    }
  }
  router.use("/sps/member-devices", async (req, res, next) => {
    host(req);
    res.set("Cache-Control", "no-store");
    if (options.management) {
      const authority = await safe(() => options.management!.resolveHostSession(req));
      options.management.assertActive();
      authorities.set(req, authority);
    }
    next();
  });
  router.get("/sps/member-devices", async (req, res) => {
    const devices = await safe(() => service.listHost(authorities.get(req)));
    options.management?.assertActive();
    res.json(devices);
  });
  router.get("/sps/member-devices/status", (_req, res) => {
    if (!options.management) throw new HttpError(503, "Native Host device management is unavailable.");
    options.management.assertActive();
    res.json({ hostId: options.management.hostId, serverSpkiSha256: options.management.serverSpkiSha256 });
  });
  router.get("/sps/member-devices/:deviceId/events", async (req, res) => {
    const events = await safe(() => service.listEvents(id(req, "deviceId"), authorities.get(req)));
    options.management?.assertActive();
    res.json(events);
  });
  router.post("/sps/member-devices/:deviceId/approve", async (req, res) => {
    const actorUserId = host(req), deviceId = id(req, "deviceId");
    empty(req);
    res.json(await safe(() => service.approve(deviceId, actorUserId, authorities.get(req))));
  });
  router.post("/sps/member-devices/:deviceId/revoke", async (req, res) => {
    const actorUserId = host(req), deviceId = id(req, "deviceId");
    empty(req);
    const device = await safe(() => service.revoke(deviceId, actorUserId, authorities.get(req)));
    await safe(async () => { await options.onRevoked?.(device.id); });
    res.json(device);
  });
  // Product registration must complete the actual mTLS enrollment protocol.
  // Retain the earlier membership/request surface only for explicit legacy composition.
  if (options.management) return router;
  router.get("/companies/:companyId/sps-member-device-requests", async (req, res) => {
    const scope = ownScope(req);
    res.set("Cache-Control", "no-store").json(await safe(() => service.listOwn(scope.companyId, scope.userId)));
  });
  router.post("/companies/:companyId/sps-member-device-requests", (req, _res, next) => {
    ownScope(req);
    next();
  }, validate(createSpsMemberDeviceRequestSchema), async (req, res) => {
    const scope = ownScope(req);
    const device = await safe(() => service.request({
      companyId: scope.companyId, userId: scope.userId,
      displayName: req.body.displayName, certificate: req.body.certificate,
    }));
    res.status(201).set("Cache-Control", "no-store").json(device);
  });
  return router;
}
