import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { spsMarketplaceRoutes } from "../routes/sps-marketplace.js";

let directory: string | undefined;

async function createApp(actor: Record<string, unknown>) {
  directory = await mkdtemp(path.join(os.tmpdir(), "sps-marketplace-route-"));
  const catalogPath = path.join(directory, "catalog.json");
  await writeFile(catalogPath, JSON.stringify({
    schemaVersion: 1,
    source: { id: "io.sps.official", displayName: "SPS Marketplace" },
    releases: [{
      pluginId: "plugin.one",
      version: "1.0.0",
      catalog: { displayName: "Plugin One", summary: "A plugin", categories: ["tools"] },
      capabilities: ["search"],
      publisherProfile: { displayName: "SPS" },
      compatibility: {},
    }],
  }), "utf8");
  process.env.SPS_MARKETPLACE_CATALOG_PATH = catalogPath;
  const app = express();
  app.use((req, _res, next) => {
    (req as Express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", spsMarketplaceRoutes());
  app.use(errorHandler);
  return app;
}

afterEach(async () => {
  delete process.env.SPS_MARKETPLACE_CATALOG_PATH;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SPS Marketplace routes", () => {
  it("requires authentication", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const response = await request(app).get("/api/companies/company-1/marketplace/plugins");
    expect(response.status).toBe(401);
  });

  it("requires company access and returns the standardized list", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    });
    const response = await request(app)
      .get("/api/companies/company-1/marketplace/plugins?q=plugin&limit=200");
    expect(response.status).toBe(200);
    expect(response.body.plugins[0]).toMatchObject({ pluginId: "plugin.one" });
    expect(response.body).toHaveProperty("source.id", "io.sps.official");
    expect(response.body).not.toHaveProperty("artifactUrl");

    const denied = await request(app).get("/api/companies/other/marketplace/plugins");
    expect(denied.status).toBe(403);
  });

  it("wraps plugin detail and exposes no mutation route", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }],
    });
    const response = await request(app)
      .get("/api/companies/company-1/marketplace/plugins/plugin.one");
    expect(response.status).toBe(200);
    expect(response.body.plugin).toMatchObject({ pluginId: "plugin.one" });
    expect((await request(app).post("/api/companies/company-1/marketplace/plugins/plugin.one/install")).status).toBe(404);
  });
});
