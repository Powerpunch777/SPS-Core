import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { marketplaceAssistantScopeGuard } from "../middleware/marketplace-assistant-scope-guard.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

function createApp(input: { scope?: "standard" | "marketplace_assistant" } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId,
      runId: "44444444-4444-4444-8444-444444444444",
      source: "agent_jwt",
      keyScope: input.scope === "marketplace_assistant"
        ? { kind: "marketplace_assistant", sessionId }
        : { kind: "standard" },
    };
    next();
  });
  app.use(marketplaceAssistantScopeGuard());
  app.all("/{*path}", (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("Marketplace Assistant scope guard", () => {
  it("allows only the matching company Core tool execution route", async () => {
    const allowed = await request(createApp({ scope: "marketplace_assistant" }))
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/search_marketplace_plugins`);
    expect(allowed.status).toBe(200);

    const wrongCompany = await request(createApp({ scope: "marketplace_assistant" }))
      .post("/api/companies/55555555-5555-4555-8555-555555555555/marketplace/assistant/tools/search_marketplace_plugins");
    expect(wrongCompany.status).toBe(403);

    const broadApi = await request(createApp({ scope: "marketplace_assistant" }))
      .get(`/api/companies/${companyId}/agents`);
    expect(broadApi.status).toBe(403);
    expect(broadApi.body.code).toBe("marketplace_assistant_scope_denied");
  });

  it("does not restrict standard Agent tokens", async () => {
    const response = await request(createApp({ scope: "standard" }))
      .get(`/api/companies/${companyId}/agents`);
    expect(response.status).toBe(200);
  });
});
