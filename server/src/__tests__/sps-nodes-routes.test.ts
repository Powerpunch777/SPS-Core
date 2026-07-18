import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  spsAgentNodeBindings,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodeAgentGrants,
  spsNodeHeartbeats,
  spsNodes,
} from "@paperclipai/db";
import { spsNodeHeartbeatMessage, spsNodeSignedRequestMessage } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string, userId: string, membershipRole: "owner" | "admin" | "operator") {
  return {
    type: "board" as const,
    userId,
    source: "session" as const,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" as const }],
    isInstanceAdmin: false,
  };
}

async function createApp(db: Db, actor: ReturnType<typeof boardActor>) {
  const { spsNodeRoutes } = await import("../routes/sps-nodes.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", spsNodeRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyFixture(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `SPS Nodes ${randomUUID()}`,
      issuePrefix: `SN${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const ownerUserId = `owner-${randomUUID()}`;
  const operatorUserId = `operator-${randomUUID()}`;
  await db.insert(companyMemberships).values([
    {
      companyId: company.id,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    },
    {
      companyId: company.id,
      principalType: "user",
      principalId: operatorUserId,
      status: "active",
      membershipRole: "operator",
    },
  ]);
  const agent = await db
    .insert(agents)
    .values({ companyId: company.id, name: "Worker", role: "engineer" })
    .returning()
    .then((rows) => rows[0]!);
  return { company, ownerUserId, operatorUserId, agent };
}

function createNodePayload() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    payload: {
      displayName: "Friend PC",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      platform: "Windows 11",
      appVersion: "0.1.0",
      capabilities: [
        { kind: "codex_cli", label: "Codex CLI", version: "0.114.0", models: ["gpt-5.6"] },
        { kind: "ollama", label: "Ollama", models: ["qwen3"] },
      ],
    },
  };
}

function createSignedHeartbeat(nodeId: string, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]) {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(32).toString("base64url");
  const message = spsNodeHeartbeatMessage({ nodeId, timestamp, nonce });
  return {
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createSignedNodeRequest(
  nodeId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  path: string,
  payload: Record<string, unknown>,
) {
  const timestamp = new Date().toISOString();
  const nonce = randomBytes(32).toString("base64url");
  const bodySha256 = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  const message = spsNodeSignedRequestMessage({
    nodeId,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodySha256,
  });
  return {
    ...payload,
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

describeEmbeddedPostgres("SPS Node routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-node-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(spsNodeCommandEvents);
    await db.delete(spsNodeCommands);
    await db.delete(spsAgentNodeBindings);
    await db.delete(spsNodeAgentGrants);
    await db.delete(spsNodeHeartbeats);
    await db.delete(spsNodes);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("requires approval and an explicit Agent grant before a Node becomes primary", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();

    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    expect(registered.body.status).toBe("pending");

    const cannotGrantYet = await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    expect(cannotGrantYet.status).toBe(403);

    const cannotApproveYet = await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    expect(cannotApproveYet.status).toBe(403);
    expect(cannotApproveYet.body.error).toContain("signed heartbeat");

    const heartbeatInput = createSignedHeartbeat(registered.body.id, node.privateKey);
    const heartbeat = await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(heartbeatInput);
    expect(heartbeat.status, JSON.stringify(heartbeat.body)).toBe(200);
    expect(heartbeat.body.keyVerifiedAt).toBeTruthy();
    const replay = await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(heartbeatInput);
    expect(replay.status).toBe(403);

    const approved = await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe("active");

    const grant = await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);

    const binding = await request(app)
      .put(`/api/agents/${fixture.agent.id}/sps-node-binding`)
      .send({ nodeId: registered.body.id });
    expect(binding.status, JSON.stringify(binding.body)).toBe(200);
    expect(binding.body.nodeId).toBe(registered.body.id);

    const list = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].agentGrants).toHaveLength(1);
    expect(list.body[0].primaryAgentBindings).toHaveLength(1);
  });

  it("requires the computer owner's active SPS account for signed heartbeats", async () => {
    const fixture = await createCompanyFixture(db);
    const ownerApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const operatorApp = await createApp(db, boardActor(fixture.company.id, fixture.operatorUserId, "operator"));
    const node = createNodePayload();
    const registered = await request(ownerApp)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);

    const heartbeat = createSignedHeartbeat(registered.body.id, node.privateKey);
    const denied = await request(operatorApp)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(heartbeat);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("computer owner");

    const accepted = await request(ownerApp)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(heartbeat);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  });

  it("keeps approval and Agent execution authority with owners and admins", async () => {
    const fixture = await createCompanyFixture(db);
    const ownerApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(ownerApp)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status).toBe(201);

    const operatorApp = await createApp(
      db,
      boardActor(fixture.company.id, fixture.operatorUserId, "operator"),
    );
    const denied = await request(operatorApp).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("owners and admins");
  });

  it("revoking a Node also clears its Agent grants and primary bindings", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(app).put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`).send({});
    await request(app).put(`/api/agents/${fixture.agent.id}/sps-node-binding`).send({ nodeId: registered.body.id });

    const revoked = await request(app).post(`/api/sps-nodes/${registered.body.id}/revoke`).send({});
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.status).toBe("revoked");

    const list = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(list.status).toBe(200);
    expect(list.body[0].agentGrants).toEqual([]);
    expect(list.body[0].primaryAgentBindings).toEqual([]);
  });

  it("lets only the signed owner Node claim a command and return ordered output", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    await request(app)
      .put(`/api/agents/${fixture.agent.id}/sps-node-binding`)
      .send({ nodeId: registered.body.id });

    const queued = await db
      .insert(spsNodeCommands)
      .values({
        companyId: fixture.company.id,
        nodeId: registered.body.id,
        agentId: fixture.agent.id,
        command: "codex",
        args: ["exec"],
        env: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const claimPath = `/sps-nodes/${registered.body.id}/commands/claim-next`;
    const claimed = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}));
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.id).toBe(queued.id);
    expect(claimed.body.status).toBe("claimed");

    const eventPath = `/sps-nodes/${registered.body.id}/commands/${queued.id}/events`;
    const event = await request(app)
      .post(`/api${eventPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, eventPath, {
        sequence: 1,
        stream: "stdout",
        body: "hello from node\n",
      }));
    expect(event.status, JSON.stringify(event.body)).toBe(204);

    const completePath = `/sps-nodes/${registered.body.id}/commands/${queued.id}/complete`;
    const complete = await request(app)
      .post(`/api${completePath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath, {
        status: "succeeded",
        exitCode: 0,
        signal: null,
        timedOut: false,
        error: null,
      }));
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    expect(complete.body.status).toBe("succeeded");
  });

  it("fails a queued command when its Node grant is revoked before claim", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    await request(app)
      .put(`/api/agents/${fixture.agent.id}/sps-node-binding`)
      .send({ nodeId: registered.body.id });
    const queued = await db
      .insert(spsNodeCommands)
      .values({
        companyId: fixture.company.id,
        nodeId: registered.body.id,
        agentId: fixture.agent.id,
        command: "codex",
        args: ["exec"],
        env: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    await request(app)
      .delete(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});

    const claimPath = `/sps-nodes/${registered.body.id}/commands/claim-next`;
    const claimed = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}));
    expect(claimed.status).toBe(204);

    const failed = await db
      .select()
      .from(spsNodeCommands)
      .where(eq(spsNodeCommands.id, queued.id))
      .then((rows) => rows[0]!);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("revoked or reassigned");
  });

  it("invalidates an active command lease when an Agent grant is revoked", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    await request(app)
      .put(`/api/agents/${fixture.agent.id}/sps-node-binding`)
      .send({ nodeId: registered.body.id });
    const queued = await db
      .insert(spsNodeCommands)
      .values({
        companyId: fixture.company.id,
        nodeId: registered.body.id,
        agentId: fixture.agent.id,
        command: "codex",
        args: ["exec"],
        env: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    const claimPath = `/sps-nodes/${registered.body.id}/commands/claim-next`;
    await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}));

    await request(app)
      .delete(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});

    const leasePath = `/sps-nodes/${registered.body.id}/commands/${queued.id}/lease`;
    const lease = await request(app)
      .post(`/api${leasePath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, leasePath, {}));
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    expect(lease.body.active).toBe(false);
    expect(lease.body.status).toBe("failed");

    const failed = await db
      .select()
      .from(spsNodeCommands)
      .where(eq(spsNodeCommands.id, queued.id))
      .then((rows) => rows[0]!);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("no longer has access");
  });
});
