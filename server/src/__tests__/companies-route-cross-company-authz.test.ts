import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpsWorkspacePluginRuntimeUnavailableError } from "../services/sps-workspace-plugin-workers.js";

const companyAId = "11111111-1111-4111-8111-111111111111";
const companyBId = "22222222-2222-4222-8222-222222222222";
const ceoAgentId = "ceo-agent-a";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockExecutionControl = vi.hoisted(() => ({ get: vi.fn(), transition: vi.fn() }));
const mockWithWorkspaceMutation = vi.hoisted(() => vi.fn(async (_companyId: string, action: () => Promise<unknown>) => action()));

function registerCompanyRouteMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    budgetService: () => mockBudgetService,
    companyArtifactsService: () => mockCompanyArtifactsService,
    companyPortabilityService: () => mockCompanyPortabilityService,
    companyService: () => mockCompanyService,
    feedbackService: () => mockFeedbackService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/sps-workspace-execution-control.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../services/sps-workspace-execution-control.js")>();
    return { ...actual, spsWorkspaceExecutionControlService: () => mockExecutionControl };
  });
}

let appImportCounter = 0;

async function createApp(actor: Record<string, unknown>) {
  registerCompanyRouteMocks();
  appImportCounter += 1;
  const routeModulePath = `../routes/companies.js?cross-company-authz-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cross-company-authz-${appImportCounter}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/companies.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any, undefined, {
    workspaceWorkers: { withWorkspaceMutation: mockWithWorkspaceMutation } as any,
  }));
  app.use(errorHandler);
  return app;
}

function createCompany(id: string) {
  const now = new Date("2026-06-18T00:00:00.000Z");
  return {
    id,
    name: id === companyAId ? "Company A" : "Company B",
    description: null,
    status: "active",
    issuePrefix: id === companyAId ? "CPA" : "CPB",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    brandColor: "#123456",
    logoAssetId: null,
    logoUrl: null,
    attachmentMaxBytes: 25_000_000,
    createdAt: now,
    updatedAt: now,
  };
}

const exportRequest = {
  include: { company: true, agents: true, projects: true },
};

function exportResult() {
  return {
    rootPath: "paperclip",
    manifest: {
      agents: [],
      skills: [],
      projects: [],
      issues: [],
      envInputs: [],
      includes: { company: true, agents: true, projects: true, issues: false, skills: false },
      company: null,
      schemaVersion: 1,
      generatedAt: "2026-06-18T00:00:00.000Z",
      source: null,
    },
    files: {},
    warnings: [],
  };
}

function exportPreviewResult() {
  return {
    ...exportResult(),
    fileInventory: [],
    counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
    paperclipExtensionPath: ".paperclip.yaml",
  };
}

function importRequest(targetCompanyId = companyBId) {
  return {
    source: { type: "inline", files: { "COMPANY.md": "---\nname: Imported\n---\n" } },
    include: { company: true, agents: true, projects: false, issues: false },
    target: { mode: "existing_company", companyId: targetCompanyId },
    collisionStrategy: "rename",
  };
}

function importResult(companyId = companyBId) {
  return {
    company: { id: companyId, action: "updated" },
    agents: [],
    warnings: [],
  };
}

function resetMockDefaults() {
  mockExecutionControl.get.mockReset();
  mockExecutionControl.transition.mockReset();
  mockWithWorkspaceMutation.mockReset();
  mockCompanyService.getById.mockImplementation(async (id: string) => {
    if (id === companyAId || id === companyBId) return createCompany(id);
    return null;
  });
  mockCompanyService.update.mockImplementation(async (id: string, body: Record<string, unknown>) => ({
    ...createCompany(id),
    ...body,
  }));
  mockCompanyService.archive.mockImplementation(async (id: string) => ({
    ...createCompany(id),
    status: "archived",
  }));
  mockCompanyService.remove.mockImplementation(async (id: string) => createCompany(id));
  mockExecutionControl.get.mockResolvedValueOnce({ state: "running", epoch: "0", revision: 2,
    pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } }).mockResolvedValue({ state: "stopped", epoch: "1", revision: 3,
    pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } });
  mockExecutionControl.transition.mockResolvedValue({ state: "stopped", epoch: "1", revision: 3,
    cancellationFailures: [], pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } });
  mockWithWorkspaceMutation.mockImplementation(async (_companyId: string, action: () => Promise<unknown>) => action());
  mockAgentService.getById.mockImplementation(async (id: string) => {
    if (id === ceoAgentId) return { id, companyId: companyAId, role: "ceo" };
    return null;
  });
  mockCompanyPortabilityService.exportBundle.mockResolvedValue(exportResult());
  mockCompanyPortabilityService.previewExport.mockResolvedValue(exportPreviewResult());
  mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
  mockCompanyPortabilityService.importBundle.mockResolvedValue(importResult());
}

function assertNoTargetMutationSideEffects() {
  expect(mockCompanyService.update).not.toHaveBeenCalled();
  expect(mockCompanyService.archive).not.toHaveBeenCalled();
  expect(mockCompanyService.remove).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  expect(mockLogActivity).not.toHaveBeenCalled();
}

function companyACeoActor() {
  return {
    type: "agent",
    agentId: ceoAgentId,
    companyId: companyAId,
    source: "agent_key",
    runId: "run-1",
  };
}

function boardActor(input: {
  userId: string;
  companyIds?: string[];
  memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
  isInstanceAdmin?: boolean;
  source?: string;
}) {
  return {
    type: "board",
    userId: input.userId,
    source: input.source ?? "session",
    companyIds: input.companyIds ?? [],
    memberships: input.memberships ?? [],
    isInstanceAdmin: input.isInstanceAdmin ?? false,
  };
}

describe.sequential("company route cross-company authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    resetMockDefaults();
  });

  it.each([
    {
      label: "GET /api/companies/:companyId",
      request: (app: express.Express) => request(app).get(`/api/companies/${companyBId}`),
    },
    {
      label: "PATCH /api/companies/:companyId",
      request: (app: express.Express) => request(app).patch(`/api/companies/${companyBId}`).send({ description: "Nope" }),
    },
    {
      label: "PATCH /api/companies/:companyId/branding",
      request: (app: express.Express) => request(app).patch(`/api/companies/${companyBId}/branding`).send({ brandColor: "#654321" }),
    },
    {
      label: "POST /api/companies/:companyId/archive",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/archive`).send({}),
    },
    {
      label: "DELETE /api/companies/:companyId",
      request: (app: express.Express) => request(app).delete(`/api/companies/${companyBId}`),
    },
    {
      label: "POST /api/companies/:companyId/export",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/export`).send(exportRequest),
    },
    {
      label: "POST /api/companies/:companyId/exports/preview",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/exports/preview`).send(exportRequest),
    },
    {
      label: "POST /api/companies/:companyId/imports/preview",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/imports/preview`).send(importRequest()),
    },
    {
      label: "POST /api/companies/:companyId/imports/apply",
      request: (app: express.Express) => request(app).post(`/api/companies/${companyBId}/imports/apply`).send(importRequest()),
    },
  ])("rejects a company A CEO attempting company B operation: $label", async ({ request: buildRequest }) => {
    const app = await createApp(companyACeoActor());

    const res = await buildRequest(app);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/another company|access to this company|active company access/i);
    assertNoTargetMutationSideEffects();
  });

  it("allows a same-company CEO to use CEO-safe company routes without allowing board-only lifecycle routes", async () => {
    const app = await createApp(companyACeoActor());

    await request(app).get(`/api/companies/${companyAId}`).expect(200);
    await request(app).patch(`/api/companies/${companyAId}`).send({ brandColor: "#abcdef" }).expect(200);
    await request(app).patch(`/api/companies/${companyAId}/branding`).send({ brandColor: "#abcdef" }).expect(200);
    await request(app).post(`/api/companies/${companyAId}/export`).send(exportRequest).expect(200);
    await request(app).post(`/api/companies/${companyAId}/exports/preview`).send(exportRequest).expect(200);
    await request(app).post(`/api/companies/${companyAId}/imports/preview`).send(importRequest(companyAId)).expect(200);
    await request(app).post(`/api/companies/${companyAId}/imports/apply`).send(importRequest(companyAId)).expect(200);

    const archive = await request(app).post(`/api/companies/${companyAId}/archive`).send({});
    expect(archive.status).toBe(403);
    expect(archive.body.error).toContain("Board access required");
    const remove = await request(app).delete(`/api/companies/${companyAId}`);
    expect(remove.status).toBe(403);
    expect(remove.body.error).toContain("Board access required");
  });

  it("covers board actor access for non-member, viewer, active member, local trusted board, and instance admin without target membership", async () => {
    const nonMemberApp = await createApp(boardActor({ userId: "outsider" }));
    const nonMember = await request(nonMemberApp).get(`/api/companies/${companyBId}`);
    expect(nonMember.status).toBe(403);
    expect(nonMember.body.error).toContain("access to this company");

    vi.clearAllMocks();
    resetMockDefaults();
    const viewerApp = await createApp(boardActor({
      userId: "viewer",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "viewer", status: "active" }],
    }));
    await request(viewerApp).get(`/api/companies/${companyBId}`).expect(200);
    const viewerWrite = await request(viewerApp).patch(`/api/companies/${companyBId}`).send({ description: "Nope" });
    expect(viewerWrite.status).toBe(403);
    expect(viewerWrite.body.error).toContain("Viewer access is read-only");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();

    vi.clearAllMocks();
    resetMockDefaults();
    const memberApp = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    await request(memberApp).patch(`/api/companies/${companyBId}`).send({ description: "Updated" }).expect(200);
    await request(memberApp).patch(`/api/companies/${companyBId}/branding`).send({ brandColor: "#abcdef" }).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/archive`).send({}).expect(200);
    await request(memberApp).delete(`/api/companies/${companyBId}`).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/export`).send(exportRequest).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/exports/preview`).send(exportRequest).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/imports/preview`).send(importRequest()).expect(200);
    await request(memberApp).post(`/api/companies/${companyBId}/imports/apply`).send(importRequest()).expect(200);

    vi.clearAllMocks();
    resetMockDefaults();
    const localTrustedApp = await createApp(boardActor({
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    }));
    await request(localTrustedApp).get(`/api/companies/${companyBId}`).expect(200);
    await request(localTrustedApp).patch(`/api/companies/${companyBId}`).send({ description: "Local" }).expect(200);

    vi.clearAllMocks();
    resetMockDefaults();
    const adminWithoutMembershipApp = await createApp(boardActor({
      userId: "instance-admin",
      isInstanceAdmin: true,
    }));
    const adminRead = await request(adminWithoutMembershipApp).get(`/api/companies/${companyBId}`);
    expect(adminRead.status).toBe(403);
    expect(adminRead.body.error).toContain("access to this company");
    const adminWrite = await request(adminWithoutMembershipApp).patch(`/api/companies/${companyBId}`).send({ description: "Admin" });
    expect(adminWrite.status).toBe(403);
    expect(adminWrite.body.error).toContain("access to this company");
    assertNoTargetMutationSideEffects();
  });

  it("stops execution and removes only after the fenced workspace drain", async () => {
    const app = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));

    await request(app).delete(`/api/companies/${companyBId}`).expect(200, { ok: true });

    expect(mockWithWorkspaceMutation).toHaveBeenCalledWith(companyBId, expect.any(Function));
    expect(mockExecutionControl.get).toHaveBeenCalledTimes(2);
    expect(mockExecutionControl.transition).toHaveBeenCalledWith(companyBId, "stop", "member", 2);
    expect(mockCompanyService.remove).toHaveBeenCalledWith(companyBId, { epoch: "1", revision: 3 });
  });

  it("keeps the Workspace when cancellation remains pending after stop", async () => {
    const app = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    mockExecutionControl.get.mockReset();
    mockExecutionControl.get.mockResolvedValueOnce({ state: "running", epoch: "0", revision: 2,
      pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } }).mockResolvedValueOnce({ state: "stopped", epoch: "1", revision: 3,
      pending: { agents: 1, jobs: 0, models: 0, commands: 0, plugins: 0 } });

    const response = await request(app).delete(`/api/companies/${companyBId}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Workspace execution cleanup is still pending.",
      code: "workspace_cleanup_pending", execution: { state: "stopped", epoch: "1", revision: 3 } });
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("keeps the Workspace when a stop handler reports unconfirmed cleanup", async () => {
    const app = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    mockExecutionControl.transition.mockResolvedValueOnce({ state: "stopped", epoch: "1", revision: 3,
      cancellationFailures: ["heartbeat"], pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } });

    const response = await request(app).delete(`/api/companies/${companyBId}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Workspace execution cleanup is still pending.",
      code: "workspace_cleanup_pending", execution: { state: "stopped", epoch: "1", revision: 3 } });
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("does not delete when execution resumed after the stop snapshot", async () => {
    const app = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    mockExecutionControl.get.mockReset();
    mockExecutionControl.get.mockResolvedValueOnce({ state: "running", epoch: "0", revision: 2,
      pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } }).mockResolvedValueOnce({ state: "running", epoch: "1", revision: 4,
      pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } });

    const response = await request(app).delete(`/api/companies/${companyBId}`);

    expect(response.status).toBe(409);
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });

  it("keeps the Workspace when the worker drain cannot confirm process closure", async () => {
    const app = await createApp(boardActor({
      userId: "member",
      companyIds: [companyBId],
      memberships: [{ companyId: companyBId, membershipRole: "member", status: "active" }],
    }));
    mockWithWorkspaceMutation.mockRejectedValueOnce(new SpsWorkspacePluginRuntimeUnavailableError());

    const response = await request(app).delete(`/api/companies/${companyBId}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Workspace execution cleanup is still pending.",
      code: "workspace_cleanup_pending" });
    expect(mockCompanyService.remove).not.toHaveBeenCalled();
  });
});
