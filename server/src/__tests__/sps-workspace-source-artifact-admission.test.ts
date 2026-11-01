import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));

const companyId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const nodeId = "33333333-3333-4333-8333-333333333333";
const desktopToken = "workspace-source-admission-test";
const busyCode = "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY";
const originalDesktopToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const source = {
  id: sourceId,
  companyId,
  displayName: "Client",
  sharePath: "\\\\host.example\\client",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function createMockDb(readRows: Array<unknown[] | Promise<unknown[]>> = [], onRead?: () => void) {
  let readIndex = 0;
  const reads = vi.fn(() => {
    const rows = readRows[readIndex++] ?? [];
    onRead?.();
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(async () => rows),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return query;
  });
  const writes = vi.fn();
  const db = {
    select: reads,
    insert: vi.fn(() => {
      writes();
      const query = {
        values: vi.fn(() => query),
        returning: vi.fn(() => query),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve([{ ...source }]).then(resolve, reject),
      };
      return query;
    }),
    update: vi.fn(() => {
      writes();
      const query = {
        set: vi.fn(() => query),
        where: vi.fn(() => query),
        returning: vi.fn(() => query),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve([{ ...source }]).then(resolve, reject),
      };
      return query;
    }),
    delete: vi.fn(() => {
      writes();
      const query = {
        where: vi.fn(async () => undefined),
      };
      return query;
    }),
  } as unknown as Db;
  return { db, reads, writes };
}

async function createApp(db: Db, artifactMaintenance = createSpsPluginArtifactMaintenance()) {
  const { spsWorkspaceSourceRoutes } = await import("../routes/sps-workspace-sources.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: unknown }).actor = {
      type: "board",
      userId: "local-host",
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", spsWorkspaceSourceRoutes(db, { artifactMaintenance }));
  app.use((err: { status?: number; message?: string; details?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({
      error: err.message ?? "Internal server error",
      ...(err.details ? { details: err.details } : {}),
    });
  });
  return app;
}

function hostRequest<T extends { set: (name: string, value: string) => T }>(test: T): T {
  return test
    .set("x-sps-desktop-access", desktopToken)
    .set("x-sps-desktop-owner-bootstrap", desktopToken)
    .set("Host", "127.0.0.1");
}

function runRequest<T>(test: { end: (callback: (error: Error | null, response: T) => void) => unknown }) {
  return new Promise<T>((resolve, reject) => {
    test.end((error, response) => error ? reject(error) : resolve(response));
  });
}

function runRequestWithTimeout<T>(test: { end: (callback: (error: Error | null, response: T) => void) => unknown }) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    runRequest<T>(test),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Workspace Source mutation did not respond")), 750);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function mutationRequests(app: express.Express) {
  return [
    () => hostRequest(request(app).post(`/api/companies/${companyId}/sps-workspace-sources`)).send({ displayName: "New" }),
    () => hostRequest(request(app).patch(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}`)).send({ displayName: "Renamed" }),
    () => hostRequest(request(app).delete(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}`)),
    () => hostRequest(request(app).put(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}/nodes/${nodeId}`)).send({
      credentialAlgorithm: "rsa-oaep-sha256+a256gcm",
      credentialEnvelope: Buffer.alloc(128, 7).toString("base64"),
    }),
    () => hostRequest(request(app).delete(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}/nodes/${nodeId}`)),
  ];
}

describe("SPS Workspace Source artifact mutation admission", () => {
  beforeEach(() => {
    process.env.SPS_DESKTOP_ACCESS_TOKEN = desktopToken;
  });

  afterEach(() => {
    if (originalDesktopToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalDesktopToken;
  });

  it("rejects all five authenticated mutations during maintenance before any database access", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const { db, reads, writes } = createMockDb();
    const app = await createApp(db, maintenance);
    const release = deferred<void>();
    const held = maintenance.withMaintenance(async () => release.promise);
    try {
      for (const send of mutationRequests(app)) {
        const response = await runRequestWithTimeout<request.Response>(send());
        expect(response.status).toBe(409);
        expect(response.body.details).toMatchObject({ code: busyCode });
      }
      expect(reads).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await held;
    }
  }, 20_000);

  it("holds activity through the response and admits maintenance after completion", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const selectStarted = deferred<void>();
    const finishSelect = deferred<unknown[]>();
    const { db } = createMockDb([finishSelect.promise], () => selectStarted.resolve());
    const app = await createApp(db, maintenance);
    const responsePromise = hostRequest(request(app)
      .patch(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}`))
      .send({ displayName: "Renamed" });
    const responseWait = runRequest<request.Response>(responsePromise);
    await selectStarted.promise;
    await expect(maintenance.withMaintenance(async () => {})).rejects.toMatchObject({ code: busyCode });
    finishSelect.resolve([source]);
    expect((await responseWait).status).toBe(200);
    await maintenance.withMaintenance(async () => {});
  });

  it("releases activity when a database operation fails", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const failure = new Error("controlled database failure");
    const readsStarted = deferred<void>();
    const failSelect = deferred<unknown[]>();
    const { db } = createMockDb([failSelect.promise], () => readsStarted.resolve());
    const app = await createApp(db, maintenance);
    const responsePromise = hostRequest(request(app)
      .patch(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}`))
      .send({ displayName: "Renamed" });
    const responseWait = runRequest<request.Response>(responsePromise);
    await readsStarted.promise;
    failSelect.reject(failure);
    const response = await responseWait;
    expect(response.status).toBe(500);
    await maintenance.withMaintenance(async () => {});
  });

  it("keeps GET available during maintenance", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const { db, reads } = createMockDb([[], [], []]);
    const app = await createApp(db, maintenance);
    const release = deferred<void>();
    const held = maintenance.withMaintenance(async () => release.promise);
    try {
      const response = await runRequest<request.Response>(hostRequest(request(app).get(`/api/companies/${companyId}/sps-workspace-sources`)));
      expect(response.status).toBe(200);
      expect(reads).toHaveBeenCalledTimes(3);
    } finally {
      release.resolve();
      await held;
    }
  });
});
