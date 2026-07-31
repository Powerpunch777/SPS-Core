import { Router } from "express";
import { assertCompanyAccess } from "./authz.js";
import { getMarketplacePlugin, searchMarketplacePlugins } from "../services/sps-marketplace.js";

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function queryLimit(value: unknown): number | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function spsMarketplaceRoutes() {
  const router = Router();
  router.get("/companies/:companyId/marketplace/plugins", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await searchMarketplacePlugins({
      q: queryString(req.query.q),
      category: queryString(req.query.category),
      capability: queryString(req.query.capability),
      limit: queryLimit(req.query.limit),
    }));
  });
  router.get("/companies/:companyId/marketplace/plugins/:pluginId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await getMarketplacePlugin(req.params.pluginId as string));
  });
  return router;
}
