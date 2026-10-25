import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "built-in-agents.ts": "/api",
  "cloud-upstreams.ts": "/api",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "sps-executions.ts": "/api",
  "sps-marketplace.ts": "/api",
  "sps-model-connections.ts": "/api",
  "sps-member-devices.ts": "/api",
  "sps-nodes.ts": "/api",
  "sps-workspace-surfaces.ts": "/api",
  "sps-workspace-sources.ts": "/api",
  "teams-catalog.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const spsHostOperations = [
  ["get", "/api/companies/{companyId}/sps-executions"],
  ["get", "/api/companies/{companyId}/sps-executions/summary"],
  ["get", "/api/companies/{companyId}/sps-executions/{lane}/{runId}"],
  ["get", "/api/companies/{companyId}/sps-model-connections"],
  ["post", "/api/companies/{companyId}/sps-model-connections"],
  ["patch", "/api/companies/{companyId}/sps-model-connections/{connectionId}"],
  ["get", "/api/companies/{companyId}/sps-model-connections/{connectionId}/grants"],
  ["post", "/api/companies/{companyId}/sps-model-connections/{connectionId}/grants"],
  ["post", "/api/companies/{companyId}/sps-model-grants/{grantId}/revoke"],
] as const;
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
  // Case routes are experimental (enableCases flag) and not yet in the public OpenAPI document.
  "cases.ts",
]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const unknownRouteFiles: string[] = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      routes.add(`${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`);
    }

    if (file === "companies.ts" && source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")) {
      routes.add("POST /api/companies/import");
    }
  }

  return { routes, unknownRouteFiles: unknownRouteFiles.sort() };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe("Create an agent API key");
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
  });

  it("documents SPS Host proof and no-store responses without treating a Board session as Host authority", () => {
    const { spec } = loadSpecRoutes();
    expect(spec.components.securitySchemes).toMatchObject({
      SpsDesktopAccessAuth: { type: "apiKey", in: "header", name: "x-sps-desktop-access" },
      SpsDesktopOwnerBootstrapAuth: { type: "apiKey", in: "header", name: "x-sps-desktop-owner-bootstrap" },
    });
    for (const [method, routePath] of spsHostOperations) {
      const operation = spec.paths[routePath][method];
      expect(operation.security).toEqual([
        { BoardSessionAuth: [], SpsDesktopAccessAuth: [], SpsDesktopOwnerBootstrapAuth: [] },
        { BoardApiKeyAuth: [], SpsDesktopAccessAuth: [], SpsDesktopOwnerBootstrapAuth: [] },
      ]);
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board", spsCoreHost: true, workspaceAccess: true });
      expect(operation.description).toContain("direct loopback");
      expect(operation.description).toContain("A Board session or API key alone is not Host authority");
      expect(operation.description).toContain("local_implicit");
      expect(operation.responses["403"]).toBeDefined();
      const success = operation.responses["200"] ?? operation.responses["201"] ?? operation.responses["204"];
      expect(success.headers["Cache-Control"].schema).toEqual({ type: "string", enum: ["no-store"] });
    }
  });

  it("keeps optional Native device management session-only and separates local Host proofs from pending registration", () => {
    const { spec } = loadSpecRoutes();
    const userSecurity = [{ SpsIdentitySessionAuth: [] }, { BoardSessionAuth: [] }];
    const hostSecurity = userSecurity.map((session) => ({
      ...session, SpsDesktopAccessAuth: [], SpsDesktopOwnerBootstrapAuth: [],
    }));
    const hostOperations = [
      ["get", "/api/sps/member-devices"],
      ["get", "/api/sps/member-devices/{deviceId}/events"],
      ["post", "/api/sps/member-devices/{deviceId}/approve"],
      ["post", "/api/sps/member-devices/{deviceId}/revoke"],
    ];
    for (const [method, path] of hostOperations) {
      const operation = spec.paths[path][method];
      expect(operation.security).toEqual(hostSecurity);
      expect(operation["x-sps-authorization"]).toEqual({ actor: "user_session", localDesktopHost: true, hostScoped: true });
      expect(operation.description).toContain("nativeConnectivityHostId");
      expect(operation.description).toContain("No LAN listener");
    }
    const path = "/api/companies/{companyId}/sps-member-device-requests";
    for (const method of ["get", "post"]) {
      const operation = spec.paths[path][method];
      expect(operation.security).toEqual(userSecurity);
      expect(operation["x-sps-authorization"]).toEqual({ actor: "user_session", currentWorkspaceMembership: true, pendingOnly: true });
    }
    const create = spec.paths[path].post;
    expect(create.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
    expect(create.requestBody.content["application/json"].schema.required).toEqual(["displayName", "certificate"]);
    expect(create.responses["201"].content["application/json"].schema.properties).not.toHaveProperty("certificate");
    expect(create.responses["201"].content["application/json"].schema.additionalProperties).toBe(false);
    const status = spec.paths["/api/sps/member-devices/status"].get;
    expect(status.security).toEqual([{
      SpsIdentitySessionAuth: [], SpsDesktopAccessAuth: [], SpsDesktopOwnerBootstrapAuth: [],
    }]);
    expect(status["x-sps-authorization"]).toEqual({ actor: "user_session", localDesktopHost: true, hostScoped: true });
    expect(status.description).toContain("startup-bound Owner's real SPS Identity cookie");
    expect(status.description).toContain("no Authorization header");
    const binding = status.responses["200"].content["application/json"].schema;
    expect(binding.additionalProperties).toBe(false);
    expect(Object.keys(binding.properties).sort()).toEqual(["hostId", "serverSpkiSha256"]);
    expect(binding.properties.serverSpkiSha256.pattern).toBe("^[0-9a-f]{64}$");
    expect(status.responses).toHaveProperty("503");
    expect(status.responses["200"].headers["Cache-Control"]).toBeDefined();
  });

  it("documents execution metadata, model-request lane, and bounded history/summary filters", () => {
    const { spec } = loadSpecRoutes();
    const list = spec.paths["/api/companies/{companyId}/sps-executions"].get;
    const listParameters = Object.fromEntries(list.parameters.map((parameter: any) => [parameter.name, parameter]));
    const lanes = ["node", "agent_session", "model_request"];
    expect(listParameters.companyId).toMatchObject({ in: "path", required: true, schema: { type: "string", format: "uuid" } });
    expect(listParameters.pluginId).toMatchObject({ in: "query", required: true, schema: { format: "uuid" } });
    expect(listParameters.limit.schema).toEqual({ type: "string", pattern: "^(?:[1-9]\\d?|100)$" });
    expect(listParameters.lane.schema.enum).toEqual(lanes);
    expect(listParameters.beforeLane.schema.enum).toEqual(lanes);
    expect(listParameters.beforeCreatedAt.schema).toMatchObject({ format: "date-time", pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$" });
    expect(list.description).toContain("all three");

    const page = list.responses["200"].content["application/json"].schema;
    const metadata = page.properties.items.items;
    expect(metadata.properties.lane.enum).toEqual(lanes);
    expect(metadata.properties.runtime.properties.modelSource.enum).toEqual(["reported", "configured", "unavailable"]);
    expect(metadata.properties.usage.properties.inputTokens.properties.provenance.enum).toEqual(["reported", "estimated", "unavailable"]);
    expect(metadata.additionalProperties).toBe(false);
    expect(metadata.properties).not.toHaveProperty("input");
    expect(metadata.properties).not.toHaveProperty("output");
    expect(metadata.properties).not.toHaveProperty("endpoint");
    expect(page.properties.nextCursor.properties.lane.enum).toEqual(lanes);

    const detail = spec.paths["/api/companies/{companyId}/sps-executions/{lane}/{runId}"].get;
    expect(detail.parameters.find((parameter: any) => parameter.name === "lane")).toMatchObject({ in: "path", required: true, schema: { enum: lanes } });
    expect(detail.parameters.find((parameter: any) => parameter.name === "runId").schema.format).toBe("uuid");
    const summary = spec.paths["/api/companies/{companyId}/sps-executions/summary"].get;
    expect(summary.parameters.filter((parameter: any) => parameter.in === "query" && parameter.required).map((parameter: any) => parameter.name)).toEqual(["pluginId", "from", "to"]);
    expect(summary.parameters.find((parameter: any) => parameter.name === "lane").schema.enum).toEqual(lanes);
    expect(summary.description).toContain("31 days");
    expect(summary.description).toContain("agentId is invalid with node or model_request");
    expect(summary.responses["422"]).toBeDefined();
  });

  it("uses the model validators and documents create/status/grant/revoke bodies and statuses", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/sps-model-connections";
    const create = spec.paths[base].post;
    const body = create.requestBody.content["application/json"].schema;
    expect(body).toMatchObject({
      type: "object", additionalProperties: false, required: ["displayName", "secretId", "transport"],
      properties: { displayName: { minLength: 1, maxLength: 160 }, secretId: { format: "uuid" } },
    });
    expect(body.properties.transport).toMatchObject({
      additionalProperties: false, required: ["endpoint", "model"],
      properties: {
        endpoint: { type: "string", minLength: 1, maxLength: 2048 },
        allowLoopbackHttp: { type: "boolean" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        maxConcurrentRequests: { type: "integer", minimum: 1, maximum: 16 },
      },
    });
    expect(body.properties.version.oneOf).toEqual([{ type: "string", enum: ["latest"] }, { type: "integer", minimum: 1, maximum: 2147483647 }]);
    expect(create.responses["201"]).toBeDefined();
    expect(create.responses["200"]).toBeUndefined();
    expect(create.responses["422"]).toBeDefined();
    const status = spec.paths[`${base}/{connectionId}`].patch.requestBody.content["application/json"].schema;
    expect(status).toEqual({ type: "object", properties: { status: { type: "string", enum: ["active", "disabled"] } }, required: ["status"], additionalProperties: false });
    const grant = spec.paths[`${base}/{connectionId}/grants`].post;
    expect(grant.requestBody.content["application/json"].schema).toEqual({ type: "object", properties: { pluginId: { type: "string", format: "uuid" } }, required: ["pluginId"], additionalProperties: false });
    expect(grant.responses["201"]).toBeDefined();
    expect(grant.responses["422"]).toBeDefined();
    const revoke = spec.paths["/api/companies/{companyId}/sps-model-grants/{grantId}/revoke"].post;
    expect(revoke.requestBody).toMatchObject({ required: false, content: { "application/json": { schema: { type: "object", properties: {}, additionalProperties: false } } } });
    expect(revoke.responses["204"]).toBeDefined();
    expect(revoke.responses["204"].content).toBeUndefined();
    expect(revoke.responses["200"]).toBeUndefined();
    expect(spec.paths[base].get.responses["200"].content["application/json"].schema.items.properties).toHaveProperty("secretId");
    expect(spec.paths[`${base}/{connectionId}/grants`].get.responses["200"].content["application/json"].schema.items.properties.revision).toEqual({ type: "integer", minimum: 0, exclusiveMinimum: true });
  });
});
