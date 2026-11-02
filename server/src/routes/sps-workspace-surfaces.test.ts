import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveInboxAction: vi.fn(),
  setInboxUserState: vi.fn(),
  logActivity: vi.fn(),
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getMembership: vi.fn(),
  call: vi.fn(),
  hostCall: vi.fn(),
}));

vi.mock("../services/sps-workspace-surfaces.js", () => ({
  spsWorkspaceSurfaceService: () => ({
    resolveInboxAction: mocks.resolveInboxAction,
    setInboxUserState: mocks.setInboxUserState,
  }),
}));
vi.mock("../compat/paperclip/control-plane.js", () => ({
  assertBoard: mocks.assertBoard,
  assertCompanyAccess: mocks.assertCompanyAccess,
  hasSpsCoreHostAuthority: () => false,
  accessService: () => ({ getMembership: mocks.getMembership }),
  logActivity: mocks.logActivity,
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const pluginId = "11111111-1111-4111-8111-111111111111";
const itemId = "33333333-3333-4333-8333-333333333333";
const actor = { type: "board" as const, userId: "user-1" };

async function createApp(withWorkspaceCaller: boolean) {
  const { spsWorkspaceSurfaceRoutes } = await import("./sps-workspace-surfaces.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", spsWorkspaceSurfaceRoutes({} as never, { call: mocks.hostCall } as never,
    withWorkspaceCaller ? { call: mocks.call } as never : undefined));
  app.use((error: unknown, _req: unknown, res: any, _next: unknown) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "error" });
  });
  return app;
}

describe("Workspace Inbox action worker routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertBoard.mockImplementation(() => undefined);
    mocks.assertCompanyAccess.mockImplementation(() => undefined);
    mocks.getMembership.mockResolvedValue({ status: "active" });
    mocks.resolveInboxAction.mockResolvedValue({
      item: { id: itemId, externalId: "review-1", opaqueReference: { token: "opaque" } },
      plugin: { id: pluginId, manifestJson: { entrypoints: { workspaceWorker: "./workspace-worker.js" } } },
      declaration: { action: "review.open" },
    });
    mocks.setInboxUserState.mockResolvedValue({ id: itemId });
    mocks.logActivity.mockResolvedValue(undefined);
    mocks.call.mockImplementation(async (...args: any[]) => {
      await args[5].assertCurrent();
      return { accepted: true };
    });
    mocks.hostCall.mockResolvedValue({ accepted: true });
  });

  it("dispatches declared Inbox actions to the fixed Workspace caller and rechecks action ownership", async () => {
    const app = await createApp(true);
    const res = await request(app).post(`/api/companies/${companyId}/workspace-inbox/${itemId}/actions/open`);
    expect(res.status).toBe(200);
    expect(mocks.call).toHaveBeenCalledWith(companyId, pluginId, "performAction", expect.objectContaining({
      key: "review.open",
      params: { companyId, inboxItemId: itemId, externalId: "review-1", opaqueReference: { token: "opaque" } },
      actorContext: { type: "user", userId: "user-1", agentId: null, runId: null, companyId },
    }), 30_000, expect.objectContaining({ boundWorkspaceId: companyId, assertCurrent: expect.any(Function) }));
    expect(mocks.resolveInboxAction).toHaveBeenCalledTimes(2);
    expect(mocks.hostCall).not.toHaveBeenCalled();
  });

  it("fails closed when the Workspace caller is missing", async () => {
    const app = await createApp(false);
    const res = await request(app).post(`/api/companies/${companyId}/workspace-inbox/${itemId}/actions/open`);
    expect(res.status).toBe(501);
    expect(mocks.hostCall).not.toHaveBeenCalled();
  });

  it("revokes an Inbox invocation when Workspace membership is no longer active", async () => {
    mocks.getMembership.mockResolvedValue({ status: "suspended" });
    const app = await createApp(true);
    const res = await request(app).post(`/api/companies/${companyId}/workspace-inbox/${itemId}/actions/open`);
    expect(res.status).toBe(500);
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(mocks.hostCall).not.toHaveBeenCalled();
    expect(mocks.setInboxUserState).not.toHaveBeenCalled();
  });
});
