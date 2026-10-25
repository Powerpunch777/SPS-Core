import express from "express";
import request from "supertest";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { spsModelConnectionRoutes } from "../routes/sps-model-connections.js";

const mocks = vi.hoisted(() => ({
  serviceFactory: vi.fn(),
  listHost: vi.fn(),
  create: vi.fn(),
  setStatus: vi.fn(),
  listGrants: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/sps-model-connections.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sps-model-connections.js")>();
  return { ...actual, spsModelConnectionService: mocks.serviceFactory };
});
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.logActivity }));

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const SECRET_ID = "44444444-4444-4444-8444-444444444444";
const PLUGIN_ID = "55555555-5555-4555-8555-555555555555";
const HOST_TOKEN = "sps-model-connection-route-test-token";
const CONNECTION_PATH = `/api/companies/${COMPANY_ID}/sps-model-connections`;
const CONNECTION_RESOURCE_PATH = `${CONNECTION_PATH}/${CONNECTION_ID}`;
const GRANT_REVOKE_PATH = `/api/companies/${COMPANY_ID}/sps-model-grants/${GRANT_ID}/revoke`;
const originalBaselineMode = process.env.SPS_CORE_BASELINE_MODE;
const originalDesktopToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;

const hostActor = {
  type: "board",
  source: "session",
  userId: "route-test-host",
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "owner", status: "active" }],
  isInstanceAdmin: true,
};

const connection = {
  id: CONNECTION_ID,
  companyId: COMPANY_ID,
  displayName: "Primary model",
  secretId: SECRET_ID,
  endpoint: "https://provider.example.test/v1/responses",
};
const grant = { id: GRANT_ID, companyId: COMPANY_ID, connectionId: CONNECTION_ID, pluginId: PLUGIN_ID };

const createBody = {
  displayName: "Primary model",
  secretId: SECRET_ID,
  transport: {
    endpoint: "https://provider.example.test/v1/responses",
    model: "fixture-model",
  },
};

type RouteRequest = (app: express.Express) => request.Test;

const routeRequests: Array<[string, RouteRequest]> = [
  ["list", app => request(app).get(CONNECTION_PATH)],
  ["create", app => request(app).post(CONNECTION_PATH).send({ unexpected: true })],
  ["status update", app => request(app).patch(CONNECTION_RESOURCE_PATH).send({ unexpected: true })],
  ["grant list", app => request(app).get(`${CONNECTION_RESOURCE_PATH}/grants`)],
  ["grant", app => request(app).post(`${CONNECTION_RESOURCE_PATH}/grants`).send({ unexpected: true })],
  ["revoke", app => request(app).post(GRANT_REVOKE_PATH).send([])],
];

function appFor(actor: unknown = hostActor) {
  const app = express();
  app.use(express.json({ strict: false }));
  app.use((req, _res, next) => { Object.assign(req, { actor }); next(); });
  app.use("/api", spsModelConnectionRoutes({} as Db));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Validation error" });
      return;
    }
    const httpError = err as { status?: number; message?: string };
    res.status(httpError.status ?? 500).json({ error: httpError.message ?? "Internal error" });
  });
  return app;
}

function hostProof(test: request.Test) {
  return test
    .set("Host", "127.0.0.1")
    .set("x-sps-desktop-access", HOST_TOKEN)
    .set("x-sps-desktop-owner-bootstrap", HOST_TOKEN);
}

function expectNoModelServiceCalls() {
  expect(mocks.listHost).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.setStatus).not.toHaveBeenCalled();
  expect(mocks.listGrants).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.revoke).not.toHaveBeenCalled();
}

function configureSuccessfulServices() {
  mocks.listHost.mockResolvedValue([connection]);
  mocks.create.mockResolvedValue(connection);
  mocks.setStatus.mockResolvedValue(connection);
  mocks.listGrants.mockResolvedValue([grant]);
  mocks.grant.mockResolvedValue(grant);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.serviceFactory.mockReturnValue({
    listHost: mocks.listHost,
    create: mocks.create,
    setStatus: mocks.setStatus,
    listGrants: mocks.listGrants,
    grant: mocks.grant,
    revoke: mocks.revoke,
  });
}

describe("SPS model connection Host routes", () => {
  beforeEach(() => {
    process.env.SPS_CORE_BASELINE_MODE = "1";
    process.env.SPS_DESKTOP_ACCESS_TOKEN = HOST_TOKEN;
    for (const method of [mocks.listHost, mocks.create, mocks.setStatus, mocks.listGrants, mocks.grant, mocks.revoke, mocks.logActivity, mocks.serviceFactory]) {
      method.mockReset();
    }
    configureSuccessfulServices();
    mocks.logActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalBaselineMode === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
    else process.env.SPS_CORE_BASELINE_MODE = originalBaselineMode;
    if (originalDesktopToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalDesktopToken;
  });

  it.each(routeRequests)("requires Host middleware before validation for the %s endpoint", async (_name, makeRequest) => {
    const app = appFor();
    const response = await makeRequest(app).expect(403);

    expect(response.body).toEqual({ error: "Only the SPS Host can manage this Core setting" });
    expectNoModelServiceCalls();
  });

  it.each(routeRequests)("rejects missing or invalid Host proof on the %s endpoint before service calls", async (_name, makeRequest) => {
    const app = appFor();

    await makeRequest(app)
      .set("Host", "127.0.0.1")
      .set("x-sps-desktop-access", HOST_TOKEN)
      .expect(403);
    await makeRequest(app)
      .set("Host", "127.0.0.1")
      .set("x-sps-desktop-access", HOST_TOKEN)
      .set("x-sps-desktop-owner-bootstrap", "wrong-token")
      .expect(403);

    expectNoModelServiceCalls();
  });

  it("enforces tenant membership even with valid local Host proof", async () => {
    const app = appFor({ ...hostActor, companyIds: [OTHER_COMPANY_ID] });

    const response = await hostProof(request(app).get(CONNECTION_PATH)).expect(403);

    expect(response.body).toEqual({ error: "User does not have access to this company" });
    expectNoModelServiceCalls();
  });

  it.each(routeRequests)("rejects unknown query parameters on the %s endpoint", async (_name, makeRequest) => {
    const response = await hostProof(makeRequest(appFor()).query({ unexpected: "value" })).expect(400);

    expect(response.body).toEqual({ error: "Unknown model connection query parameter" });
    expectNoModelServiceCalls();
  });

  it("rejects malformed and missing Workspace path IDs without service calls", async () => {
    const app = appFor();
    const malformed = await hostProof(request(app).get("/api/companies/not-a-uuid/sps-model-connections")).expect(400);
    await hostProof(request(app).get("/api/companies/sps-model-connections")).expect(404);

    expect(malformed.body).toEqual({ error: "Invalid Workspace ID" });
    expectNoModelServiceCalls();
  });

  it.each([
    ["status update", (app: express.Express) => request(app).patch(`${CONNECTION_PATH}/not-a-uuid`).send({ status: "active" })],
    ["grant list", (app: express.Express) => request(app).get(`${CONNECTION_PATH}/not-a-uuid/grants`)],
    ["grant", (app: express.Express) => request(app).post(`${CONNECTION_PATH}/not-a-uuid/grants`).send({ pluginId: PLUGIN_ID })],
    ["revoke", (app: express.Express) => request(app).post(`/api/companies/${COMPANY_ID}/sps-model-grants/not-a-uuid/revoke`).send({})],
  ] as Array<[string, RouteRequest]>) ("rejects malformed resource IDs for %s", async (_name, makeRequest) => {
    const response = await hostProof(makeRequest(appFor())).expect(400);

    expect(response.body).toEqual({ error: "Invalid model resource ID" });
    expectNoModelServiceCalls();
  });

  it.each([
    ["create", app => request(app).post(CONNECTION_PATH).send({ ...createBody, endpoint: "https://unexpected.example.test", key: "sk-never-log", tools: [] })],
    ["nested create transport", app => request(app).post(CONNECTION_PATH).send({ ...createBody, transport: { ...createBody.transport, key: "sk-never-log" } })],
    ["status update", app => request(app).patch(CONNECTION_RESOURCE_PATH).send({ status: "active", endpoint: "https://unexpected.example.test", key: "sk-never-log", tools: [] })],
    ["grant", app => request(app).post(`${CONNECTION_RESOURCE_PATH}/grants`).send({ pluginId: PLUGIN_ID, endpoint: "https://unexpected.example.test", key: "sk-never-log", tools: [] })],
  ] as Array<[string, RouteRequest]>) ("applies strict body schemas to %s requests", async (_name, makeRequest) => {
    const response = await hostProof(makeRequest(appFor())).expect(400);

    expect(response.body).toEqual({ error: "Validation error" });
    expectNoModelServiceCalls();
  });

  it.each([
    ["empty array", []],
    ["nonempty array", ["field"]],
    ["null", null],
    ["number", 1],
    ["boolean", true],
    ["string", "unexpected"],
    ["nonempty object", { endpoint: "https://unexpected.example.test", key: "sk-never-log" }],
  ])("rejects %s as a revoke body", async (_label, body) => {
    const response = await hostProof(
      request(appFor()).post(GRANT_REVOKE_PATH).set("Content-Type", "application/json").send(JSON.stringify(body)),
    ).expect(400);

    expect(response.body).toEqual({ error: "Revoke request does not accept fields" });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("allows absent and empty plain-object revoke bodies", async () => {
    const app = appFor();

    await hostProof(request(app).post(GRANT_REVOKE_PATH)).expect(204);
    await hostProof(request(app).post(GRANT_REVOKE_PATH).send({})).expect(204);

    expect(mocks.revoke).toHaveBeenCalledTimes(2);
    expect(mocks.revoke).toHaveBeenNthCalledWith(1, COMPANY_ID, GRANT_ID);
    expect(mocks.revoke).toHaveBeenNthCalledWith(2, COMPANY_ID, GRANT_ID);
  });

  it.each([
    ["list", app => request(app).get(CONNECTION_PATH), 200],
    ["create", app => request(app).post(CONNECTION_PATH).send(createBody), 201],
    ["status update", app => request(app).patch(CONNECTION_RESOURCE_PATH).send({ status: "active" }), 200],
    ["grant list", app => request(app).get(`${CONNECTION_RESOURCE_PATH}/grants`), 200],
    ["grant", app => request(app).post(`${CONNECTION_RESOURCE_PATH}/grants`).send({ pluginId: PLUGIN_ID }), 201],
    ["revoke", app => request(app).post(GRANT_REVOKE_PATH).send({}), 204],
  ] as Array<[string, RouteRequest, number]>) ("disables caching on successful %s responses", async (_name, makeRequest, status) => {
    const response = await hostProof(makeRequest(appFor())).expect(status);

    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("forwards only validated route data and keeps audit details free of connection secrets", async () => {
    const app = appFor();
    const secretMarker = "sk-never-log-in-audit";

    await hostProof(request(app).get(CONNECTION_PATH)).expect(200);
    await hostProof(request(app).post(CONNECTION_PATH).send(createBody)).expect(201);
    await hostProof(request(app).patch(CONNECTION_RESOURCE_PATH).send({ status: "disabled" })).expect(200);
    await hostProof(request(app).get(`${CONNECTION_RESOURCE_PATH}/grants`)).expect(200);
    await hostProof(request(app).post(`${CONNECTION_RESOURCE_PATH}/grants`).send({ pluginId: PLUGIN_ID })).expect(201);
    await hostProof(request(app).post(GRANT_REVOKE_PATH).send({})).expect(204);

    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(COMPANY_ID, createBody, hostActor.userId);
    expect(mocks.setStatus).toHaveBeenCalledExactlyOnceWith(COMPANY_ID, CONNECTION_ID, "disabled");
    expect(mocks.grant).toHaveBeenCalledExactlyOnceWith(COMPANY_ID, CONNECTION_ID, PLUGIN_ID, hostActor.userId);
    expect(mocks.logActivity).toHaveBeenCalledTimes(4);
    const auditPayloads = mocks.logActivity.mock.calls.map(([, payload]) => payload);
    expect(auditPayloads.map(payload => payload.entityType)).toEqual([
      "sps_model_connection",
      "sps_model_connection",
      "sps_model_connection",
      "sps_model_grant",
    ]);
    for (const payload of auditPayloads) {
      expect(payload.details).toEqual({});
      expect(JSON.stringify(payload)).not.toContain(secretMarker);
      expect(JSON.stringify(payload)).not.toContain(createBody.transport.endpoint);
      expect(JSON.stringify(payload)).not.toContain(SECRET_ID);
    }
  });

  it.each([
    ["list", app => request(app).get(CONNECTION_PATH), "Workspace is unavailable", 404, () => mocks.listHost],
    ["create", app => request(app).post(CONNECTION_PATH).send(createBody), "Model connection could not be saved", 422, () => mocks.create],
    ["status update", app => request(app).patch(CONNECTION_RESOURCE_PATH).send({ status: "active" }), "Model connection is unavailable", 404, () => mocks.setStatus],
    ["grant list", app => request(app).get(`${CONNECTION_RESOURCE_PATH}/grants`), "Model connection is unavailable", 404, () => mocks.listGrants],
    ["grant", app => request(app).post(`${CONNECTION_RESOURCE_PATH}/grants`).send({ pluginId: PLUGIN_ID }), "Model connection could not be approved for this Plugin", 422, () => mocks.grant],
    ["revoke", app => request(app).post(GRANT_REVOKE_PATH).send({}), "Model grant is unavailable", 404, () => mocks.revoke],
  ] as Array<[string, RouteRequest, string, number, () => ReturnType<typeof vi.fn>]>) (
    "maps %s service failures to fixed sanitized errors",
    async (_name, makeRequest, fixedMessage, status, selectMock) => {
      const selected = selectMock();
      selected.mockRejectedValueOnce(new Error("provider-secret-marker and https://secret.example.test"));

      const response = await hostProof(makeRequest(appFor())).expect(status);

      expect(response.body).toEqual({ error: fixedMessage });
      expect(JSON.stringify(response.body)).not.toContain("provider-secret-marker");
      expect(JSON.stringify(response.body)).not.toContain("secret.example.test");
    },
  );
});
