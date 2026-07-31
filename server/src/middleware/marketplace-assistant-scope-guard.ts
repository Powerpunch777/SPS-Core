import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

const TOOL_ROUTE = /^\/api\/companies\/([^/]+)\/marketplace\/assistant\/tools\/([^/]+)\/?$/;

export function marketplaceAssistantScopeGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor.type !== "agent" || req.actor.keyScope?.kind !== "marketplace_assistant") {
      next();
      return;
    }

    const match = TOOL_ROUTE.exec(req.path);
    if (
      req.method.toUpperCase() === "POST" &&
      match &&
      match[1] === req.actor.companyId
    ) {
      next();
      return;
    }

    next(forbidden("Marketplace Assistant tokens can only execute Core marketplace tools", {
      code: "marketplace_assistant_scope_denied",
    }));
  };
}
