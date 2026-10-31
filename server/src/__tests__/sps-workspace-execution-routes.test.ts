import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { spsWorkspaceExecutionRoutes } from "../routes/sps-workspace-execution.js";

const service = vi.hoisted(() => ({ get: vi.fn(), transition: vi.fn() }));
vi.mock("../services/sps-workspace-execution-control.js", () => ({ spsWorkspaceExecutionControlService: () => service }));
const companyId = "11111111-1111-4111-8111-111111111111";
const path = `/api/companies/${companyId}/execution-control`;
function app(actor: Record<string, unknown>) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  app.use("/api/companies/:companyId/execution-control", spsWorkspaceExecutionRoutes({} as never));
  app.use(errorHandler); return app;
}
beforeEach(() => { vi.resetAllMocks(); service.get.mockResolvedValue({ state: "running", epoch: "0", revision: 0 }); });

it("allows a Member to read only its Workspace and never mutate Host execution policy", async () => {
  const application = app({ type: "board", source: "session", userId: "member", companyIds: [companyId], isInstanceAdmin: false });
  const result = await request(application).get(path);
  expect(result.status).toBe(200); expect(result.body.canControl).toBe(false);
  expect((await request(application).post(path).send({ action: "stop", expectedRevision: 0 })).status).toBe(403);
  expect(service.transition).not.toHaveBeenCalled();
  expect((await request(application).get(path.replace(companyId, "22222222-2222-4222-8222-222222222222"))).status).toBe(403);
  expect(service.get).toHaveBeenCalledTimes(1);
});

it("denies Agent credentials even for their own Workspace", async () => {
  const application = app({ type: "agent", agentId: "agent", companyId });
  expect((await request(application).get(path)).status).toBe(403);
  expect((await request(application).post(path).send({ action: "resume", expectedRevision: 0 })).status).toBe(403);
  expect(service.get).not.toHaveBeenCalled(); expect(service.transition).not.toHaveBeenCalled();
});

it("Host mutation passes its displayed revision and actor, and rejects extra authority selectors", async () => {
  const application = app({ type: "board", source: "local_implicit", userId: "owner" });
  service.transition.mockResolvedValue({ state: "stopped", epoch: "1", revision: 5 });
  const result = await request(application).post(path).send({ action: "stop", expectedRevision: 4 });
  expect(result.status).toBe(200);
  expect(service.transition).toHaveBeenCalledWith(companyId, "stop", "owner", 4);
  expect((await request(application).post(path).send({ action: "resume", expectedRevision: 5, companyId: "foreign" })).status).toBe(400);
  expect(service.transition).toHaveBeenCalledTimes(1);
});
