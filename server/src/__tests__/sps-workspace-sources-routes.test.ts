import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  spsNodes,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const DESKTOP_TOKEN = "sps-workspace-source-route-test";

function hostActor(companyId: string) {
  return {
    type: "board" as const,
    userId: "local-host",
    source: "local_implicit" as const,
    companyIds: [companyId],
    memberships: [],
    isInstanceAdmin: true,
  };
}

async function createApp(
  db: Db,
  companyId: string,
  actor: ReturnType<typeof hostActor> | {
    type: "board";
    userId: string;
    source: "session";
    companyIds: string[];
    memberships: Array<{ companyId: string; membershipRole: "owner"; status: "active" }>;
    isInstanceAdmin: boolean;
  } = hostActor(companyId),
) {
  const { spsWorkspaceSourceRoutes } = await import("../routes/sps-workspace-sources.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: typeof actor }).actor = actor;
    next();
  });
  app.use("/api", spsWorkspaceSourceRoutes(db));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

function hostRequest<T extends { set: (name: string, value: string) => T }>(test: T): T {
  return test
    .set("x-sps-desktop-access", DESKTOP_TOKEN)
    .set("x-sps-desktop-owner-bootstrap", DESKTOP_TOKEN)
    .set("Host", "127.0.0.1");
}

describeEmbeddedPostgres("SPS Workspace Source routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let app: express.Express;
  const originalToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;

  beforeAll(async () => {
    process.env.SPS_DESKTOP_ACCESS_TOKEN = DESKTOP_TOKEN;
    database = await startEmbeddedPostgresTestDatabase("sps-workspace-sources-");
    db = createDb(database.connectionString);
    const company = await db
      .insert(companies)
      .values({
        name: `Workspace Sources ${randomUUID()}`,
        issuePrefix: `WS${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    app = await createApp(db, companyId);
  }, 30_000);

  afterAll(async () => {
    if (originalToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalToken;
    await database?.cleanup();
  });

  it("keeps Host source paths out of the public source model and stores only encrypted Node grants", async () => {
    const create = await hostRequest(request(app)
      .post(`/api/companies/${companyId}/sps-workspace-sources`))
      .send({ displayName: "Client" })
      .expect(201);
    expect(create.body).toMatchObject({ displayName: "Client", status: "active" });
    expect(create.body.sharePath).toBeUndefined();

    const sourceId = create.body.id as string;
    await hostRequest(request(app)
      .patch(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}`))
      .send({ sharePath: "\\\\host.example.ts.net\\SPS_client" })
      .expect(200);
    const node = await db
      .insert(spsNodes)
      .values({
        companyId,
        ownerUserId: "member",
        displayName: "Member laptop",
        publicKey: "member-public-key",
        transportPublicKey: "-----BEGIN PUBLIC KEY-----\nmember\n-----END PUBLIC KEY-----",
        platform: "windows",
        status: "active",
        keyVerifiedAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
    const envelope = Buffer.alloc(128, 7).toString("base64");
    await hostRequest(request(app)
      .put(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}/nodes/${node.id}`))
      .send({ credentialAlgorithm: "rsa-oaep-sha256+a256gcm", credentialEnvelope: envelope })
      .expect(200);

    const listed = await hostRequest(request(app)
      .get(`/api/companies/${companyId}/sps-workspace-sources`))
      .expect(200);
    expect(listed.body.sources).toEqual([
      expect.objectContaining({
        id: sourceId,
        displayName: "Client",
        nodeGrants: [expect.objectContaining({ nodeId: node.id, status: "granted" })],
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toContain("SPS_client");
    expect(JSON.stringify(listed.body)).not.toContain(envelope);

    await hostRequest(request(app)
      .delete(`/api/companies/${companyId}/sps-workspace-sources/${sourceId}/nodes/${node.id}`))
      .expect(204);
    const afterRevoke = await hostRequest(request(app)
      .get(`/api/companies/${companyId}/sps-workspace-sources`))
      .expect(200);
    expect(afterRevoke.body.sources[0].nodeGrants).toEqual([
      expect.objectContaining({ nodeId: node.id, status: "revoked" }),
    ]);
  });

  it("rejects a regular Workspace request even when it has a valid company actor", async () => {
    await request(app)
      .post(`/api/companies/${companyId}/sps-workspace-sources`)
      .send({ displayName: "Blocked", sharePath: "\\\\host.example.ts.net\\SPS_blocked" })
      .expect(403);
  });

  it("rejects a remote legacy instance admin from changing Host Workspace Sources", async () => {
    const remoteApp = await createApp(db, companyId, {
      type: "board",
      userId: "remote-legacy-admin",
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    });

    const response = await request(remoteApp)
      .post(`/api/companies/${companyId}/sps-workspace-sources`)
      .send({ displayName: "Remote attempt" });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("Only the local SPS Host");
  });
});
