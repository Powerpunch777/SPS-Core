import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { accessRoutes } from "../routes/access.js";

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", accessRoutes({} as never, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describe("SPS Core baseline instance administration", () => {
  it("rejects a remote legacy instance admin before an access-admin route reaches storage", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    try {
      const app = createApp({
        type: "board",
        userId: "remote-admin",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [],
      });

      const response = await request(app).get("/api/admin/users");

      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Only the SPS Host");
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
    }
  });
});
