import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

export function marketplaceAssistantScopeGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor.type !== "agent" || req.actor.keyScope?.kind !== "marketplace_assistant") {
      next();
      return;
    }

    // This credential scope is retained only to reject old tokens safely.
    // The Marketplace Assistant runtime and its former tool endpoint are retired.
    next(forbidden("Marketplace Assistant credentials are retired", {
      code: "marketplace_assistant_scope_denied",
    }));
  };
}
