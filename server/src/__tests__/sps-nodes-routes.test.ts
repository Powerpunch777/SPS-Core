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
  projects,
  spsAgentNodeBindings,
  spsHostProjectShareNodeGrants,
  spsHostProjectShares,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodeAgentGrants,
  spsNodeAgentRunnerGrants,
  spsNodeHeartbeats,
  spsNodeRunnerProfiles,
  spsPluginExecutionGrants,
  spsPluginArtifacts,
  spsPluginNodeRunEvents,
  spsPluginNodeRuns,
  spsNodes,
  spsWorkspaceSourceNodeGrants,
  spsWorkspaceSources,
} from "@paperclipai/db";
import { spsNodeHeartbeatMessage, spsNodeSignedRequestMessage } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveSpsNodeExecutionTarget } from "../services/sps-node-execution.js";
import { spsPluginExecutionService } from "../services/sps-plugin-execution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boardActor(
  companyId: string,
  userId: string,
  membershipRole: "owner" | "admin" | "operator",
  options: { source?: "session" | "local_implicit"; isInstanceAdmin?: boolean } = {},
) {
  return {
    type: "board" as const,
    userId,
    source: options.source ?? "session",
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" as const }],
    isInstanceAdmin: options.isInstanceAdmin ?? false,
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
    .values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "codex_local" })
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
    await db.delete(spsPluginArtifacts);
    await db.delete(spsPluginNodeRunEvents);
    await db.delete(spsPluginNodeRuns);
    await db.delete(spsPluginExecutionGrants);
    await db.delete(spsNodeCommandEvents);
    await db.delete(spsNodeCommands);
    await db.delete(spsNodeAgentRunnerGrants);
    await db.delete(spsAgentNodeBindings);
    await db.delete(spsNodeAgentGrants);
    await db.delete(spsNodeHeartbeats);
    await db.delete(spsNodeRunnerProfiles);
    await db.delete(spsHostProjectShareNodeGrants);
    await db.delete(spsHostProjectShares);
    await db.delete(spsWorkspaceSourceNodeGrants);
    await db.delete(spsWorkspaceSources);
    await db.delete(spsNodes);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("requires approval and makes an Agent's first granted Node primary", async () => {
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

    const firstList = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(firstList.status).toBe(200);
    expect(firstList.body[0].primaryAgentBindings).toHaveLength(1);
    expect(firstList.body[0].primaryAgentBindings[0].agentId).toBe(fixture.agent.id);

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
    expect(list.body[0].runners).toHaveLength(2);
    expect(list.body[0].runners.map((runner: { runnerKey: string }) => runner.runnerKey).sort()).toEqual([
      "codex_cli:default",
      "ollama:default",
    ]);
    const codexRunner = list.body[0].runners.find((runner: { runnerKey: string }) => (
      runner.runnerKey === "codex_cli:default"
    ));
    expect(codexRunner).toMatchObject({
      runnerKey: "codex_cli:default",
      credentialStatus: "unknown",
      availabilityStatus: "unknown",
    });
    expect(codexRunner.agentGrants).toHaveLength(1);
  }, 20_000);

  it("returns an encrypted Workspace Source route only to its granted signed Node", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const nodePayload = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send({
        ...nodePayload.payload,
        transportPublicKey: "-----BEGIN PUBLIC KEY-----\\nnode-transport\\n-----END PUBLIC KEY-----",
      })
      .expect(201);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, nodePayload.privateKey))
      .expect(200);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({}).expect(200);

    const source = await db
      .insert(spsWorkspaceSources)
      .values({
        companyId: fixture.company.id,
        displayName: "Host game source",
        sharePath: "\\\\host.example.ts.net\\SPS_game",
        createdByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const envelope = Buffer.alloc(128, 3).toString("base64");
    const claimPath = `/sps-nodes/${registered.body.id}/workspace-sources/${source.id}/claim-route`;

    const denied = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, nodePayload.privateKey, claimPath, {}));
    expect(denied.status).toBe(403);

    await db.insert(spsWorkspaceSourceNodeGrants).values({
      companyId: fixture.company.id,
      sourceId: source.id,
      nodeId: registered.body.id,
      credentialAlgorithm: "rsa-oaep-sha256+a256gcm",
      credentialEnvelope: envelope,
      grantedByUserId: fixture.ownerUserId,
    });
    const claimed = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, nodePayload.privateKey, claimPath, {}));
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body).toEqual({
      kind: "sps_workspace_source",
      sourceId: source.id,
      sharePath: "\\\\host.example.ts.net\\SPS_game",
      credentialAlgorithm: "rsa-oaep-sha256+a256gcm",
      credentialEnvelope: envelope,
    });
  }, 20_000);

  it("records a signed Runner availability snapshot without receiving local credentials", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);

    const path = `/sps-nodes/${registered.body.id}/runners/availability`;
    const payload = {
      runners: [{
        runnerKey: "codex_cli:default",
        credentialStatus: "ready",
        availability: {
          status: "quota_limited",
          observedAt: "2026-07-22T01:00:00.000Z",
          source: "adapter",
          confidence: 80,
          retryAfter: "2026-07-22T02:00:00.000Z",
          detail: "Provider reported a temporary limit.",
        },
      }],
    };
    const reported = await request(app)
      .post(`/api${path}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, path, payload));
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    expect(reported.body[0]).toMatchObject({
      runnerKey: "codex_cli:default",
      credentialStatus: "ready",
      availabilityStatus: "quota_limited",
      availabilitySource: "adapter",
      availabilityConfidence: 80,
    });
    expect(JSON.stringify(reported.body)).not.toContain("privateKeyPem");

    const listed = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    const codexRunner = listed.body[0].runners.find((runner: { runnerKey: string }) => runner.runnerKey === "codex_cli:default");
    expect(codexRunner).toMatchObject({ availabilityStatus: "quota_limited" });
  });

  it("does not restore a revoked Runner grant when its Node reconnects", async () => {
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
    const granted = await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    expect(granted.status).toBe(200);

    const beforeRevocation = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    const runnerId = beforeRevocation.body[0].runners[0].id as string;
    const revoked = await request(app)
      .delete(`/api/sps-nodes/${registered.body.id}/runners/${runnerId}/agent-grants/${fixture.agent.id}`);
    expect(revoked.status).toBe(204);

    const reconnected = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(reconnected.status).toBe(200);

    const listed = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(listed.body[0].runners[0].agentGrants).toEqual([]);
  });

  it("rejects an Agent grant when the approved Node lacks that Agent's runtime", async () => {
    const fixture = await createCompanyFixture(db);
    await db
      .update(agents)
      .set({ adapterType: "sps_lm_studio_local" })
      .where(eq(agents.id, fixture.agent.id));
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();

    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});

    const denied = await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain("lm_studio");

    const listed = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].agentGrants).toEqual([]);
    expect(listed.body[0].primaryAgentBindings).toEqual([]);
  });

  it("does not grant a pending-approval Agent access to a Node", async () => {
    const fixture = await createCompanyFixture(db);
    await db
      .update(agents)
      .set({ status: "pending_approval" })
      .where(eq(agents.id, fixture.agent.id));
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();

    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});

    const denied = await request(app)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain("pending_approval");

    const listed = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].agentGrants).toEqual([]);
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

  it("keeps the company Node inventory visible only to owners and admins", async () => {
    const fixture = await createCompanyFixture(db);
    const ownerApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const operatorApp = await createApp(db, boardActor(fixture.company.id, fixture.operatorUserId, "operator"));

    const registered = await request(ownerApp)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(createNodePayload().payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);

    const denied = await request(operatorApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain("owners and admins");

    const allowed = await request(ownerApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toHaveLength(1);
  });

  it("keeps Node management with the SPS Host in the Core baseline while a Member can register", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    try {
      const fixture = await createCompanyFixture(db);
      const memberApp = await createApp(db, boardActor(fixture.company.id, fixture.operatorUserId, "operator"));
      const node = createNodePayload();
      const registered = await request(memberApp)
        .post(`/api/companies/${fixture.company.id}/sps-nodes`)
        .send(node.payload);
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);

      const memberList = await request(memberApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
      expect(memberList.status).toBe(403);
      expect(memberList.body.error).toContain("Only the SPS Host");

      const remoteAdminApp = await createApp(db, boardActor(
        fixture.company.id,
        fixture.ownerUserId,
        "owner",
        { isInstanceAdmin: true },
      ));
      const remoteAdminList = await request(remoteAdminApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
      expect(remoteAdminList.status, JSON.stringify(remoteAdminList.body)).toBe(403);

      const hostApp = await createApp(db, boardActor(
        fixture.company.id,
        fixture.ownerUserId,
        "owner",
        { source: "local_implicit" },
      ));
      const hostList = await request(hostApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
      expect(hostList.status, JSON.stringify(hostList.body)).toBe(200);
      expect(hostList.body).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
    }
  });

  it("keeps an Agent's first primary Node when another Node is granted", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const first = createNodePayload();
    const second = createNodePayload();

    const firstRegistered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(first.payload);
    const secondRegistered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(second.payload);
    for (const [registered, node] of [
      [firstRegistered, first],
      [secondRegistered, second],
    ] as const) {
      await request(app)
        .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
        .send(createSignedHeartbeat(registered.body.id, node.privateKey));
      await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    }

    await request(app)
      .put(`/api/sps-nodes/${firstRegistered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});
    await request(app)
      .put(`/api/sps-nodes/${secondRegistered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});

    const listed = await request(app).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(listed.status).toBe(200);
    const firstNode = listed.body.find((node: { id: string }) => node.id === firstRegistered.body.id);
    const secondNode = listed.body.find((node: { id: string }) => node.id === secondRegistered.body.id);
    expect(firstNode.primaryAgentBindings).toHaveLength(1);
    expect(secondNode.primaryAgentBindings).toEqual([]);
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

  it("revoking a Node also closes every active Host Source route", async () => {
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

    const source = await db
      .insert(spsWorkspaceSources)
      .values({
        companyId: fixture.company.id,
        displayName: "Shared implementation",
        sharePath: "sps://host/shared-implementation",
        createdByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const sourceGrant = await db
      .insert(spsWorkspaceSourceNodeGrants)
      .values({
        companyId: fixture.company.id,
        sourceId: source.id,
        nodeId: registered.body.id,
        credentialEnvelope: "sealed-route-credential",
        grantedByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const project = await db
      .insert(projects)
      .values({ companyId: fixture.company.id, name: "Shared implementation" })
      .returning()
      .then((rows) => rows[0]!);
    const hostShare = await db
      .insert(spsHostProjectShares)
      .values({
        companyId: fixture.company.id,
        projectId: project.id,
        sharePath: "\\\\sps-host\\shared-implementation",
        createdByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);
    const hostShareGrant = await db
      .insert(spsHostProjectShareNodeGrants)
      .values({
        companyId: fixture.company.id,
        shareId: hostShare.id,
        nodeId: registered.body.id,
        credentialEnvelope: "sealed-host-share-credential",
        grantedByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);

    const revoked = await request(app).post(`/api/sps-nodes/${registered.body.id}/revoke`).send({});
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const persistedGrant = await db
      .select()
      .from(spsWorkspaceSourceNodeGrants)
      .where(eq(spsWorkspaceSourceNodeGrants.id, sourceGrant.id))
      .then((rows) => rows[0]!);
    const persistedHostShareGrant = await db
      .select()
      .from(spsHostProjectShareNodeGrants)
      .where(eq(spsHostProjectShareNodeGrants.id, hostShareGrant.id))
      .then((rows) => rows[0]!);
    expect(persistedGrant.revokedAt).not.toBeNull();
    expect(persistedHostShareGrant.revokedAt).not.toBeNull();
  });

  it("lets a computer owner disconnect their own Node and immediately clears its execution access", async () => {
    const fixture = await createCompanyFixture(db);
    const ownerApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const computerApp = await createApp(db, boardActor(fixture.company.id, fixture.operatorUserId, "operator"));
    const node = createNodePayload();
    const registered = await request(computerApp)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    await request(computerApp)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(ownerApp).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(ownerApp)
      .put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`)
      .send({});

    const disconnected = await request(computerApp)
      .post(`/api/sps-nodes/${registered.body.id}/disconnect`)
      .send({});
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
    expect(disconnected.body.status).toBe("revoked");

    const listed = await request(ownerApp).get(`/api/companies/${fixture.company.id}/sps-nodes`);
    expect(listed.status).toBe(200);
    expect(listed.body[0].agentGrants).toEqual([]);
    expect(listed.body[0].primaryAgentBindings).toEqual([]);
    const disconnectedActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, registered.body.id))
      .then((rows) => rows.find((row) => row.action === "sps_node.disconnected") ?? null);
    expect(disconnectedActivity).not.toBeNull();
  });

  it("lets the SPS Host remove a technical Member while retaining history and revoking every Node", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    try {
      const fixture = await createCompanyFixture(db);
      const remoteAdminApp = await createApp(db, boardActor(
        fixture.company.id,
        fixture.ownerUserId,
        "owner",
        { isInstanceAdmin: true },
      ));
      const remoteAdminList = await request(remoteAdminApp).get(`/api/companies/${fixture.company.id}/sps-members`);
      expect(remoteAdminList.status, JSON.stringify(remoteAdminList.body)).toBe(403);

      const hostApp = await createApp(db, boardActor(
        fixture.company.id,
        fixture.ownerUserId,
        "owner",
        { source: "local_implicit" },
      ));
      const memberApp = await createApp(db, boardActor(fixture.company.id, fixture.operatorUserId, "operator"));
      const node = createNodePayload();
      const registered = await request(memberApp)
        .post(`/api/companies/${fixture.company.id}/sps-nodes`)
        .send(node.payload);
      await request(memberApp)
        .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
        .send(createSignedHeartbeat(registered.body.id, node.privateKey));
      await request(hostApp).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});

      const source = await db
        .insert(spsWorkspaceSources)
        .values({
          companyId: fixture.company.id,
          displayName: "Member route",
          sharePath: "sps://host/member-route",
          createdByUserId: fixture.ownerUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
      const sourceGrant = await db
        .insert(spsWorkspaceSourceNodeGrants)
        .values({
          companyId: fixture.company.id,
          sourceId: source.id,
          nodeId: registered.body.id,
          credentialEnvelope: "sealed-member-route",
          grantedByUserId: fixture.ownerUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
      const member = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.principalId, fixture.operatorUserId))
        .then((rows) => rows[0]!);

      const listed = await request(hostApp).get(`/api/companies/${fixture.company.id}/sps-members`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body.members.some((entry: Record<string, unknown>) => "membershipRole" in entry)).toBe(false);

      const memberListAttempt = await request(memberApp).get(`/api/companies/${fixture.company.id}/sps-members`);
      expect(memberListAttempt.status, JSON.stringify(memberListAttempt.body)).toBe(403);

      const removed = await request(hostApp)
        .post(`/api/companies/${fixture.company.id}/sps-members/${member.id}/revoke`)
        .send({});
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(removed.body.member.status).toBe("archived");
      expect(removed.body.revokedNodeCount).toBe(1);

      const removedMemberHeartbeat = await request(memberApp)
        .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
        .send(createSignedHeartbeat(registered.body.id, node.privateKey));
      expect(removedMemberHeartbeat.status, JSON.stringify(removedMemberHeartbeat.body)).toBe(403);
      expect(removedMemberHeartbeat.body.error).toBe("This SPS technical Member has been removed");

      const archivedMember = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.id, member.id))
        .then((rows) => rows[0]!);
      const revokedNode = await db
        .select()
        .from(spsNodes)
        .where(eq(spsNodes.id, registered.body.id))
        .then((rows) => rows[0]!);
      const revokedSourceGrant = await db
        .select()
        .from(spsWorkspaceSourceNodeGrants)
        .where(eq(spsWorkspaceSourceNodeGrants.id, sourceGrant.id))
        .then((rows) => rows[0]!);
      expect(archivedMember.status).toBe("archived");
      expect(revokedNode.status).toBe("revoked");
      expect(revokedSourceGrant.revokedAt).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
    }
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

  it("claims a plugin-owned run without requiring a Paperclip Agent and invalidates it when its grant is revoked", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload)
      .expect(201);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey))
      .expect(200);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({}).expect(200);

    const runner = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(eq(spsNodeRunnerProfiles.nodeId, registered.body.id))
      .then((rows) => rows.find((entry) => entry.kind === "codex_cli") ?? null);
    expect(runner).not.toBeNull();
    const grant = await db
      .insert(spsPluginExecutionGrants)
      .values({
        companyId: fixture.company.id,
        pluginKey: "sps.example-workplane",
        subjectKey: "worker:build-1",
        nodeId: registered.body.id,
        runnerProfileId: runner!.id,
      })
      .returning()
      .then((rows) => rows[0]!);
    const queued = await db
      .insert(spsPluginNodeRuns)
      .values({
        companyId: fixture.company.id,
        pluginKey: grant.pluginKey,
        subjectKey: grant.subjectKey,
        executionGrantId: grant.id,
        nodeId: registered.body.id,
        runnerProfileId: runner!.id,
        command: "codex",
        args: ["exec", "--json"],
        env: {},
      })
      .returning()
      .then((rows) => rows[0]!);

    const claimPath = `/sps-nodes/${registered.body.id}/plugin-runs/claim-next`;
    const claimed = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}));
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body).toMatchObject({
      id: queued.id,
      runtimeKind: "codex_cli",
      pluginKey: grant.pluginKey,
      subjectKey: grant.subjectKey,
      status: "claimed",
    });

    const eventPath = `/sps-nodes/${registered.body.id}/plugin-runs/${queued.id}/events`;
    await request(app)
      .post(`/api${eventPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, eventPath, {
        sequence: 1,
        stream: "stdout",
        body: "plugin run output\n",
      }))
      .expect(204);

    await db
      .update(spsPluginExecutionGrants)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(spsPluginExecutionGrants.id, grant.id));
    const leasePath = `/sps-nodes/${registered.body.id}/plugin-runs/${queued.id}/lease`;
    const lease = await request(app)
      .post(`/api${leasePath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, leasePath, {}));
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    expect(lease.body).toMatchObject({ active: false, status: "failed" });

    const failed = await db
      .select()
      .from(spsPluginNodeRuns)
      .where(eq(spsPluginNodeRuns.id, queued.id))
      .then((rows) => rows[0]!);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("plugin execution access was revoked");
  });

  it("exposes only safe Source metadata to a plugin while dispatching through its own execution grant", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload)
      .expect(201);
    await request(app)
      .post(`/api/sps-nodes/${registered.body.id}/heartbeat`)
      .send(createSignedHeartbeat(registered.body.id, node.privateKey))
      .expect(200);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({}).expect(200);
    const runner = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(eq(spsNodeRunnerProfiles.nodeId, registered.body.id))
      .then((rows) => rows.find((entry) => entry.kind === "codex_cli") ?? null);
    expect(runner).not.toBeNull();
    const source = await db
      .insert(spsWorkspaceSources)
      .values({
        companyId: fixture.company.id,
        displayName: "School game source",
        sharePath: "\\\\host.example.ts.net\\SPS_school_game",
        createdByUserId: fixture.ownerUserId,
      })
      .returning()
      .then((rows) => rows[0]!);

    const service = spsPluginExecutionService(db, "sps.example-workplane");
    const sources = await service.listWorkspaceSources(fixture.company.id);
    expect(sources).toEqual([expect.objectContaining({
      id: source.id,
      displayName: "School game source",
      routeStatus: "configured",
    })]);
    expect(sources[0]).not.toHaveProperty("sharePath");

    const grant = await service.upsertExecutionGrant({
      companyId: fixture.company.id,
      subjectKey: "worker:build-2",
      nodeId: registered.body.id,
      runnerProfileId: runner!.id,
      workspaceSourceId: source.id,
    });
    const run = await service.dispatchRun({
      companyId: fixture.company.id,
      executionGrantId: grant.id,
      args: ["exec", "Implement the approved change."],
      env: { PAPERCLIP_TEST: "1" },
      timeoutMs: 5_000,
    });
    expect(run).toMatchObject({
      pluginKey: "sps.example-workplane",
      subjectKey: "worker:build-2",
      workspaceSourceId: source.id,
      status: "queued",
    });
    expect(run).not.toHaveProperty("cwdHint");
    expect(run).not.toHaveProperty("command");

    const stored = await db
      .select()
      .from(spsPluginNodeRuns)
      .where(eq(spsPluginNodeRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(stored).toMatchObject({
      command: "codex",
      cwdHint: "\\\\host.example.ts.net\\SPS_school_game",
      workspaceSourceId: source.id,
    });
  });

  it("publishes workflow-neutral artifact records without accepting local file references", async () => {
    const fixture = await createCompanyFixture(db);
    const service = spsPluginExecutionService(db, "sps.example-workplane");
    const published = await service.publishArtifact({
      companyId: fixture.company.id,
      subjectKey: "worker:build-2",
      title: "Build verification report",
      kind: "report",
      referenceUrl: "https://example.test/reports/build-2",
      summary: "The build completed and awaits plugin-defined review.",
      data: { branch: "feature/core-runtime", checks: ["typecheck", "unit"] },
    });
    expect(published).toMatchObject({
      pluginKey: "sps.example-workplane",
      subjectKey: "worker:build-2",
      kind: "report",
      referenceUrl: "https://example.test/reports/build-2",
    });
    expect(published).not.toHaveProperty("sharePath");
    const stored = await db
      .select()
      .from(spsPluginArtifacts)
      .where(eq(spsPluginArtifacts.id, published.id))
      .then((rows) => rows[0]!);
    expect(stored.data).toEqual({ branch: "feature/core-runtime", checks: ["typecheck", "unit"] });
    await expect(service.publishArtifact({
      companyId: fixture.company.id,
      subjectKey: "worker:build-2",
      title: "Unsafe local file",
      referenceUrl: "file:///C:/private/project.txt",
    })).rejects.toThrow("artifact referenceUrl must use https");
    await expect(service.listArtifacts({
      companyId: fixture.company.id,
      subjectKey: "worker:build-2",
    })).resolves.toEqual([expect.objectContaining({ id: published.id })]);
  });

  it("dispatches a bound Agent run through the approved Desktop Node and returns its output", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app)
      .post(`/api/companies/${fixture.company.id}/sps-nodes`)
      .send(node.payload);
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
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

    const target = await resolveSpsNodeExecutionTarget({
      db,
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      adapterType: "codex_local",
      heartbeatRunId: null,
      projectId: null,
    });
    expect(target).toMatchObject({
      transport: "sps_node",
      nodeId: registered.body.id,
      remoteCwd: `sps-agent://${fixture.agent.id}`,
    });
    const pendingResult = target!.runner.execute({
      command: "codex",
      args: ["exec", "--json"],
      cwd: target!.remoteCwd,
      env: { SPS_TEST: "1" },
      stdin: "Summarize the assigned task.",
      timeoutMs: 5_000,
    });

    let queued: typeof spsNodeCommands.$inferSelect | null = null;
    for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
      queued = await db
        .select()
        .from(spsNodeCommands)
        .where(eq(spsNodeCommands.agentId, fixture.agent.id))
        .then((rows) => rows[0] ?? null);
      if (!queued) await wait(25);
    }
    expect(queued).not.toBeNull();
    expect(queued).toMatchObject({
      nodeId: registered.body.id,
      heartbeatRunId: null,
      command: "codex",
      args: ["exec", "--json"],
      stdin: "Summarize the assigned task.",
    });

    const claimPath = `/sps-nodes/${registered.body.id}/commands/claim-next`;
    const claimed = await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}));
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.id).toBe(queued!.id);

    const eventPath = `/sps-nodes/${registered.body.id}/commands/${queued!.id}/events`;
    const event = await request(app)
      .post(`/api${eventPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, eventPath, {
        sequence: 1,
        stream: "stdout",
        body: "Completed on Friend PC.\n",
      }));
    expect(event.status, JSON.stringify(event.body)).toBe(204);

    const completePath = `/sps-nodes/${registered.body.id}/commands/${queued!.id}/complete`;
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

    await expect(pendingResult).resolves.toMatchObject({
      exitCode: 0,
      stdout: "Completed on Friend PC.\n",
      stderr: "",
    });
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
    expect(failed.error).toContain("no longer has access");
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
