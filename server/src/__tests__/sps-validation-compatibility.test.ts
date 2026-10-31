import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { adapterRegistrySchema, pluginManifestV1Schema, workspaceFileListQuerySchema } from "@paperclipai/shared";
import { createToolDefinitions } from "../../../packages/mcp-server/src/tools.js";
import { SpsApiClient } from "../../../packages/mcp-server/src/client.js";

const pluginManifest = {
  id: "test.validation-compatibility",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Validation compatibility",
  description: "Serialized manifest contract fixture",
  author: "SPS tests",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [{
    driverKey: "fixture-driver",
    displayName: "Fixture driver",
    supportsInteractiveSetup: true,
    interactiveSetupConnectionTypes: ["ssh"],
    supportsTemplateCapture: true,
    templateRefKind: "snapshot",
    supportsTemplateDelete: true,
    configSchema: { type: "object", properties: { label: { type: "string" } } },
  }],
} as const;

describe("Core validation compatibility contracts", () => {
  it("keeps the HTTP 400 validation envelope and nested issue paths", async () => {
    const app = express();
    app.get("/files", (req, _res, next) => {
      const parsed = workspaceFileListQuerySchema.safeParse(req.query);
      if (!parsed.success) return next(parsed.error);
      next(new Error("Expected invalid fixture"));
    });
    app.use(errorHandler);

    const response = await request(app).get("/files?workspaceId=11111111-1111-4111-8111-111111111111");
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation error");
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["workspaceId"], message: "Workspace file target requires both projectId and workspaceId" }),
    ]));
  });

  it("preserves query coercion and defaults", () => {
    expect(workspaceFileListQuerySchema.parse({
      projectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      limit: "7",
    })).toMatchObject({ limit: 7, offset: 0 });

    expect(workspaceFileListQuerySchema.parse({})).toMatchObject({ limit: 25, offset: 0 });
  });

  it("preserves record schemas and object defaults", () => {
    expect(adapterRegistrySchema.parse([{ adapterType: "process" }])).toEqual([
      { adapterType: "process", enabled: true },
    ]);
    expect(adapterRegistrySchema.safeParse([{ adapterType: "process", unknown: true }]).success).toBe(false);
  });

  it("round-trips the serialized plugin manifest and retains nested field paths", () => {
    const serialized = JSON.stringify(pluginManifest);
    const parsed = pluginManifestV1Schema.parse(JSON.parse(serialized));
    expect(parsed).toMatchObject(pluginManifest);

    const invalid = JSON.parse(serialized) as { environmentDrivers: Array<Record<string, unknown>> };
    invalid.environmentDrivers[0].supportsInteractiveSetup = "yes";
    const result = pluginManifestV1Schema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected the invalid manifest to fail");
    expect(result.error.issues.some(issue => issue.path.join(".") === "environmentDrivers.0.supportsInteractiveSetup")).toBe(true);
  });

  it("preserves the MCP tool schema boundary and bounded scalar validation", () => {
    const client = new SpsApiClient({
      apiUrl: "http://localhost:3100/api",
      apiKey: "compatibility-test-token",
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    });
    const tool = createToolDefinitions(client).find(candidate => candidate.name === "spsListComments");
    expect(tool).toBeDefined();
    expect(tool!.schema.parse({ issueId: "PAP-1135", limit: 500 })).toMatchObject({ limit: 500 });
    const invalid = tool!.schema.safeParse({ issueId: "PAP-1135", limit: 501 });
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error("Expected the over-limit MCP input to fail");
    expect(invalid.error.issues.some(issue => issue.path.join(".") === "limit")).toBe(true);
  });
});
