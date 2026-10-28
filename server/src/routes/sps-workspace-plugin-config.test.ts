import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const configService = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../services/sps-workspace-plugin-config.js", () => ({
  createSpsWorkspacePluginConfigService: () => configService,
}));

import { errorHandler } from "../middleware/error-handler.js";
import { spsWorkspacePluginConfigRoutes } from "./sps-workspace-plugin-config.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const currentRevision = "44444444-4444-4444-8444-444444444444";
const nextRevision = "55555555-5555-4555-8555-555555555555";
const endpoint = `/api/plugins/${pluginId}/companies/${workspaceId}/workspace-runtime-config`;

function createApp(actor: Record<string, unknown>, options: { invalidate?: (workspaceId: string, pluginId: string, previousRevision: string | null) => Promise<void> } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", spsWorkspacePluginConfigRoutes({} as Db, options));
  app.use(errorHandler);
  return app;
}

const hostActor = {
  type: "board",
  source: "local_implicit",
  userId: "host-user-42",
  companyIds: [workspaceId],
  isInstanceAdmin: false,
};
const memberActor = {
  type: "board",
  source: "remote_session",
  userId: "member-user-7",
  companyIds: [workspaceId],
  isInstanceAdmin: false,
};

describe("SPS Workspace Plugin config routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configService.get.mockResolvedValue({ workspaceId, pluginId, configJson: {}, revision: currentRevision, updatedAt: null });
    configService.put.mockResolvedValue({ workspaceId, pluginId, configJson: { profile: "blue" }, revision: nextRevision, updatedAt: null });
    configService.remove.mockResolvedValue({ workspaceId, pluginId, configJson: {}, revision: null, updatedAt: null });
  });

  it("requires Host authority for reads even when the caller has Workspace access", async () => {
    const denied = await request(createApp(memberActor)).get(endpoint);
    expect(denied.status).toBe(403);
    expect(configService.get).not.toHaveBeenCalled();

    const allowed = await request(createApp(hostActor)).get(endpoint);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ workspaceId, pluginId, configJson: {}, revision: currentRevision });
    expect(configService.get).toHaveBeenCalledExactlyOnceWith(workspaceId, pluginId);
  });

  it("rejects body selectors and extra fields before writing", async () => {
    const response = await request(createApp(hostActor, { invalidate: vi.fn(async () => {}) }))
      .put(endpoint)
      .send({ configJson: { profile: "blue" }, expectedRevision: null, workspaceId: "foreign" });
    expect(response.status).toBe(400);
    expect(configService.put).not.toHaveBeenCalled();
  });

  it("saves before invalidation and returns the saved revision without leaking an invalidation error", async () => {
    const invalidate = vi.fn(async () => { throw new Error("secret raw worker failure"); });
    const response = await request(createApp(hostActor, { invalidate }))
      .put(endpoint)
      .send({ configJson: { profile: "blue" }, expectedRevision: currentRevision });

    expect(configService.put).toHaveBeenCalledExactlyOnceWith({
      workspaceId, pluginId, configJson: { profile: "blue" }, expectedRevision: currentRevision, actorUserId: "host-user-42",
    });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspaceId, pluginId, currentRevision);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: expect.stringContaining("saved"),
      code: "workspace_runtime_restart_unconfirmed",
      revision: nextRevision,
    });
    expect(JSON.stringify(response.body)).not.toContain("secret raw worker failure");
  });

  it("does not mutate without invalidation composition and removes with the caller's prior revision", async () => {
    const missingInvalidator = await request(createApp(hostActor))
      .put(endpoint)
      .send({ configJson: { profile: "blue" }, expectedRevision: null });
    expect(missingInvalidator.status).toBe(503);
    expect(missingInvalidator.body.code).toBe("workspace_runtime_invalidation_unavailable");
    expect(configService.put).not.toHaveBeenCalled();

    const invalidate = vi.fn(async () => { throw new Error("private runtime detail"); });
    const response = await request(createApp(hostActor, { invalidate }))
      .delete(endpoint)
      .send({ expectedRevision: currentRevision });
    expect(configService.remove).toHaveBeenCalledExactlyOnceWith({
      workspaceId, pluginId, expectedRevision: currentRevision, actorUserId: "host-user-42",
    });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(workspaceId, pluginId, currentRevision);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "workspace_runtime_restart_unconfirmed", revision: null });
    expect(JSON.stringify(response.body)).not.toContain("private runtime detail");
  });

  it("rejects malformed route selectors before service access", async () => {
    const response = await request(createApp(hostActor)).get(`/api/plugins/not-a-uuid/companies/${workspaceId}/workspace-runtime-config`);
    expect(response.status).toBe(400);
    expect(configService.get).not.toHaveBeenCalled();
  });
});
