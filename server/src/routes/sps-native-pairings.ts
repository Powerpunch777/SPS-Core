import { Router, type Request } from "express";
import type { Db } from "../compat/paperclip/db.js";
import { badRequest, forbidden, HttpError } from "../errors.js";
import { hasTrustedDesktopOwnerBootstrap } from "../middleware/desktop-local-access.js";
import { createSpsNativeHostPairings, SpsNativeHostPairingDeliveryError } from "../services/sps-native-host-pairings.js";
import { SpsNativePairingError } from "../services/sps-native-pairings.js";
import type { SpsNativeHostManagement } from "../services/sps-native-host-management.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function deny(): never { throw forbidden("SPS Native invitations require the local Host Owner session"); }

/** Explicit local Owner-only invite management. No Native listener is created. */
export function spsNativePairingRoutes(db: Db, management: SpsNativeHostManagement) {
  if (!management || typeof management.assertActive !== "function") throw new TypeError("Native Host management is required.");
  const router = Router();
  const pairings = createSpsNativeHostPairings(db, management, { maxAttempts: 5, maxActiveInvites: 10 });

  function authority(req: Request) {
    const actor = req.actor;
    if (!actor || actor.type !== "board" || actor.source !== "session" || !actor.userId
      || actor.userId.length > 200 || /[\u0000-\u001f\u007f]/.test(actor.userId)) deny();
    if (!hasTrustedDesktopOwnerBootstrap(req)) deny();
    if (Object.keys(req.query).length !== 0) throw badRequest("Unknown Native pairing query parameter");
    management.assertActive();
  }

  function emptyBody(req: Request) {
    const value = req.body;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length !== 0) {
      throw badRequest("Native pairing actions accept an empty object");
    }
  }

  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof SpsNativeHostPairingDeliveryError) throw new HttpError(error.status, error.message);
      if (error instanceof SpsNativePairingError) throw new HttpError(error.status, "SPS Native pairing state is unavailable");
      throw new HttpError(503, "SPS Native pairing state is unavailable");
    }
  }

  router.use("/sps/native-pairings", (req, res, next) => {
    authority(req);
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/sps/native-pairings", async (req, res) => {
    const result = await safe(() => pairings.list(req));
    management.assertActive();
    res.json(result);
  });
  router.post("/sps/native-pairings", async (req, res) => {
    emptyBody(req);
    const result = await safe(() => pairings.issue(req));
    management.assertActive();
    res.status(201).json({ pairingId: result.pairingId, pairingSecret: result.pairingSecret,
      issuedAt: result.issuedAt, expiresAt: result.expiresAt });
  });
  router.post("/sps/native-pairings/:pairingId/revoke", async (req, res) => {
    emptyBody(req);
    if (typeof req.params.pairingId !== "string" || !UUID.test(req.params.pairingId)) {
      throw badRequest("Invalid Native pairing ID");
    }
    const result = await safe(() => pairings.revoke(req, req.params.pairingId.toLowerCase()));
    management.assertActive();
    res.json(result);
  });
  return router;
}
