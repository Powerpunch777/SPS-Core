import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentTaskSessions,
  heartbeatRuns,
  heartbeatRunEvents,
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
import { spsAgentSessionRunService } from "../services/sps-agent-session-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getSpsWorkspaceExecutionPending, spsWorkspaceExecutionControlService } from "../services/sps-workspace-execution-control.js";
import { registerSpsWorkspaceExecutionStopHandler } from "../services/sps-workspace-execution-control.js";
import { spsExecutionHistoryService } from "../services/sps-execution-history.js";
import { buildSpsUsageEvidence } from "../services/sps-execution-observation.js";
import { createSpsExecutionUsageReceipt } from "../services/sps-execution-usage-receipt.js";
import type { PluginSpsExecutionCursor, PluginSpsExecutionPage } from "../compat/paperclip/plugin-sdk.js";
import { plugins } from "@paperclipai/db";
import { spsExecutionRoutes } from "../routes/sps-executions.js";
import { createSpsNodeCompletionReceiptDigest } from "../services/sps-node-completion-receipt.js";

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
  app.use("/api", spsExecutionRoutes(db));
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
  let startupPromise: ReturnType<typeof startEmbeddedPostgresTestDatabase> | null = null;

  beforeAll(async () => {
    startupPromise = startEmbeddedPostgresTestDatabase("sps-node-routes-");
    tempDb = await startupPromise;
    db = createDb(tempDb.connectionString);
  }, 120_000);

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
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    const ownedDatabase = tempDb ?? (startupPromise ? await startupPromise.catch(() => null) : null);
    await db?.$client.end();
    await ownedDatabase?.cleanup();
  }, 45_000);

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

    const old = new Date(Date.now() - 30 * 60 * 1000);
    await db.update(spsNodeCommands).set({ claimedAt: old, startedAt: old, updatedAt: old })
      .where(eq(spsNodeCommands.id, queued.id));
    await request(app)
      .post(`/api${claimPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {}))
      .expect(204);
    expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, queued.id)))[0])
      .toMatchObject({ status: "claimed", finishedAt: null });

    const leasePath = `/sps-nodes/${registered.body.id}/commands/${queued.id}/lease`;
    await request(app)
      .post(`/api${leasePath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, leasePath, {}))
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ active: true, status: "claimed" }));

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
    const successfulReport = { status: "succeeded" as const, exitCode: 0, signal: null, timedOut: false, error: null };
    expect(complete.body.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({
      kind: "agent-command", nodeId: registered.body.id, commandId: queued.id, completion: successfulReport,
    }));

    // Discard the first response, reconstruct the service over the same real
    // database and retry with a fresh signed nonce, as a restarted Node does.
    const restartedApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const retried = await request(restartedApp).post(`/api${completePath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath, successfulReport))
      .expect(200);
    expect(retried.body).toEqual(complete.body);

    const cancelling = await db.insert(spsNodeCommands).values({
      companyId: fixture.company.id, nodeId: registered.body.id, agentId: fixture.agent.id,
      command: "codex", args: ["exec"], env: {}, status: "cancelling", claimedAt: new Date(),
      error: "User requested cancellation.",
    }).returning().then(rows => rows[0]!);
    expect(cancelling.completionReceiptDigest).toBeNull();
    const stoppedReport = { status: "failed" as const, exitCode: 143, signal: "SIGTERM", timedOut: false, error: "local stop completed" };
    const stoppedPath = `/sps-nodes/${registered.body.id}/commands/${cancelling.id}/complete`;
    const stopped = await request(app).post(`/api${stoppedPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, stoppedPath, stoppedReport))
      .expect(200);
    expect(stopped.body).toMatchObject({ status: "cancelled", error: "User requested cancellation.", exitCode: 143 });
    expect(stopped.body.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({
      kind: "agent-command", nodeId: registered.body.id, commandId: cancelling.id, completion: stoppedReport,
    }));
    const stored = await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, cancelling.id)).then(rows => rows[0]!);
    expect(stored.completionReceiptDigest).toBe(stopped.body.completionReceiptDigest);
    const stoppedRetry = await request(restartedApp).post(`/api${stoppedPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, stoppedPath, stoppedReport)).expect(200);
    expect(stoppedRetry.body).toEqual(stopped.body);
    expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, cancelling.id)))[0]!.updatedAt).toEqual(stored.updatedAt);
  });

  it("rechecks legacy Host Project Share routes per command and preserves sibling commands", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    await request(app).put(`/api/sps-nodes/${nodeId}/agent-grants/${fixture.agent.id}`).send({}).expect(200);
    await request(app).put(`/api/agents/${fixture.agent.id}/sps-node-binding`).send({ nodeId }).expect(200);

    const project = await db.insert(projects).values({ companyId: fixture.company.id, name: "Legacy Source lease" }).returning().then(rows => rows[0]!);
    const siblingProject = await db.insert(projects).values({ companyId: fixture.company.id, name: "Sibling Source lease" }).returning().then(rows => rows[0]!);
    const sharePath = "\\\\host.example.ts.net\\SPS_legacy";
    const siblingSharePath = "\\\\host.example.ts.net\\SPS_legacy_sibling";
    const share = await db.insert(spsHostProjectShares).values({ companyId: fixture.company.id, projectId: project.id,
      sharePath, createdByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const siblingShare = await db.insert(spsHostProjectShares).values({ companyId: fixture.company.id, projectId: siblingProject.id,
      sharePath: siblingSharePath, createdByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const grant = await db.insert(spsHostProjectShareNodeGrants).values({ companyId: fixture.company.id, shareId: share.id,
      nodeId, credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: Buffer.alloc(128, 4).toString("base64"),
      grantedByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const siblingGrant = await db.insert(spsHostProjectShareNodeGrants).values({ companyId: fixture.company.id, shareId: siblingShare.id,
      nodeId, credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: Buffer.alloc(128, 5).toString("base64"),
      grantedByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const command = (shareId: string, path: string, envelope: string) => db.insert(spsNodeCommands).values({
      companyId: fixture.company.id, nodeId, agentId: fixture.agent.id, command: "codex", args: ["exec"], env: {},
      status: "claimed", claimedAt: new Date(), startedAt: new Date(), cwdHint: path,
      workspaceAccess: { kind: "sps_host_share", shareId, sharePath: path, credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: envelope },
    }).returning().then(rows => rows[0]!);
    const firstCommand = await command(share.id, sharePath, Buffer.alloc(128, 4).toString("base64"));
    const siblingCommand = await command(siblingShare.id, siblingSharePath, Buffer.alloc(128, 5).toString("base64"));

    await db.update(spsHostProjectShares).set({ sharePath: "\\\\host.example.ts.net\\SPS_legacy_replaced" })
      .where(eq(spsHostProjectShares.id, share.id));
    const firstLeasePath = `/sps-nodes/${nodeId}/commands/${firstCommand.id}/lease`;
    const firstLease = await request(app).post(`/api${firstLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, firstLeasePath, {})).expect(200);
    expect(firstLease.body).toMatchObject({ active: false, status: "failed" });

    const policyFailed = await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, firstCommand.id)).then(rows => rows[0]!);
    expect(policyFailed.completionReceiptDigest).toBeNull();
    expect((await getSpsWorkspaceExecutionPending(db, fixture.company.id)).commands).toBe(2);
    const lateReport = { status: "failed" as const, exitCode: 143, signal: "SIGTERM", timedOut: false, error: "local process closure confirmed" };
    const latePath = `/sps-nodes/${nodeId}/commands/${firstCommand.id}/complete`;
    const late = await request(app).post(`/api${latePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, latePath, lateReport)).expect(200);
    expect(late.body).toMatchObject({ status: "failed", error: policyFailed.error,
      finishedAt: policyFailed.finishedAt!.toISOString(), completionReportJson: lateReport });
    expect(late.body.completionReceiptDigest).toBe(createSpsNodeCompletionReceiptDigest({
      kind: "agent-command", nodeId, commandId: firstCommand.id, completion: lateReport,
    }));
    const restartedApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const duplicate = await request(restartedApp).post(`/api${latePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, latePath, lateReport)).expect(200);
    expect(duplicate.body).toEqual(late.body);
    expect((await getSpsWorkspaceExecutionPending(db, fixture.company.id)).commands).toBe(1);

    const siblingLeasePath = `/sps-nodes/${nodeId}/commands/${siblingCommand.id}/lease`;
    const siblingLease = await request(app).post(`/api${siblingLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, siblingLeasePath, {})).expect(200);
    expect(siblingLease.body).toMatchObject({ active: true, status: "claimed" });

    await db.update(spsHostProjectShareNodeGrants).set({ credentialAlgorithm: "unsupported" })
      .where(eq(spsHostProjectShareNodeGrants.id, siblingGrant.id));
    const badCredentialLease = await request(app).post(`/api${siblingLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, siblingLeasePath, {})).expect(200);
    expect(badCredentialLease.body).toMatchObject({ active: false, status: "failed" });
    expect((await getSpsWorkspaceExecutionPending(db, fixture.company.id)).commands).toBe(1);
    expect((await db.select().from(spsHostProjectShareNodeGrants).where(eq(spsHostProjectShareNodeGrants.id, siblingGrant.id)))[0]!.revokedAt)
      .toBeNull();
    expect((await db.select().from(spsHostProjectShareNodeGrants).where(eq(spsHostProjectShareNodeGrants.id, grant.id)))[0]!.revokedAt)
      .toBeNull();
  });

  it("keeps Agent-session cancellation pending until signed Node completion and rejects late output", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/heartbeat`).send(createSignedHeartbeat(registered.body.id, node.privateKey));
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({});
    await request(app).put(`/api/sps-nodes/${registered.body.id}/agent-grants/${fixture.agent.id}`).send({});
    await request(app).put(`/api/agents/${fixture.agent.id}/sps-node-binding`).send({ nodeId: registered.body.id });
    const pluginKey = "sps.test-session";
    const taskKey = `plugin:${pluginKey}:session:test`;
    const session = await db.insert(agentTaskSessions).values({ companyId: fixture.company.id, agentId: fixture.agent.id, adapterType: "codex_local", taskKey }).returning().then(rows => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({ companyId: fixture.company.id, agentId: fixture.agent.id, status: "running",
      contextSnapshot: { taskKey, spsPluginConversation: { pluginKey, sessionId: session.id } },
    }).returning().then(rows => rows[0]!);
    const command = await db.insert(spsNodeCommands).values({ companyId: fixture.company.id, nodeId: registered.body.id, agentId: fixture.agent.id,
      heartbeatRunId: run.id, command: "codex", args: ["exec"], env: {}, status: "running", claimedAt: new Date(), startedAt: new Date(),
    }).returning().then(rows => rows[0]!);
    const scoped = spsAgentSessionRunService(db, pluginKey, async () => { throw new Error("Must not finalize before Node acknowledgement"); });
    const params = { companyId: fixture.company.id, sessionId: session.id, runId: run.id };
    expect(await scoped.cancel(params)).toMatchObject({ status: "running", termination: "pending" });
    expect(await scoped.cancel(params)).toMatchObject({ termination: "pending" });
    const leasePath = `/sps-nodes/${registered.body.id}/commands/${command.id}/lease`;
    const lease = await request(app).post(`/api${leasePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, leasePath, {}));
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    expect(lease.body).toMatchObject({ active: false, status: "cancelling" });
    expect(await scoped.getRun(params)).toMatchObject({ status: "running", termination: "pending" });
    const completePath = `/sps-nodes/${registered.body.id}/commands/${command.id}/complete`;
    const completion = { status: "failed", exitCode: 1, signal: "SIGTERM", timedOut: false, error: "Lease was cancelled" };
    const complete = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath, completion));
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    expect(await scoped.getRun(params)).toMatchObject({ status: "cancelled", termination: "confirmed" });
    const replay = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath, completion));
    expect(replay.status).toBe(200);
    const eventPath = `/sps-nodes/${registered.body.id}/commands/${command.id}/events`;
    const late = await request(app).post(`/api${eventPath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, eventPath, { sequence: 1, stream: "stdout", body: "late" }));
    expect(late.status).toBe(403);
    expect(await scoped.getRun(params)).toMatchObject({ termination: "confirmed" });
    const target = await resolveSpsNodeExecutionTarget({ db, companyId: fixture.company.id, agentId: fixture.agent.id, adapterType: "codex_local", heartbeatRunId: run.id, projectId: null });
    await expect(target!.runner.execute({ command: "codex", args: ["exec"], env: {}, cwd: "." })).rejects.toThrow("no longer accepting remote dispatch");
    // Completion can arrive before the parent adapter observes it. A later
    // cancellation must use that signed receipt, not wait forever for a replay.
    const next = await db.insert(heartbeatRuns).values({ companyId: fixture.company.id, agentId: fixture.agent.id, status: "running",
      contextSnapshot: { taskKey, spsPluginConversation: { pluginKey, sessionId: session.id } },
    }).returning().then(rows => rows[0]!);
    const nextCommand = await db.insert(spsNodeCommands).values({ companyId: fixture.company.id, nodeId: registered.body.id, agentId: fixture.agent.id,
      heartbeatRunId: next.id, command: "codex", args: ["exec"], env: {}, status: "running", claimedAt: new Date(),
    }).returning().then(rows => rows[0]!);
    const nextCompletePath = `/sps-nodes/${registered.body.id}/commands/${nextCommand.id}/complete`;
    expect((await request(app).post(`/api${nextCompletePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, nextCompletePath, completion))).status).toBe(200);
    const laterCancel = spsAgentSessionRunService(db, pluginKey, async runId => { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId)); });
    expect(await laterCancel.cancel({ ...params, runId: next.id })).toMatchObject({ cancellationRequested: true, termination: "confirmed" });

    // An older optimistic parent flag cannot hide a policy-failed Node whose
    // remote process has not yet acknowledged closure.
    const legacyParent = await db.insert(heartbeatRuns).values({ companyId: fixture.company.id, agentId: fixture.agent.id, status: "cancelled",
      contextSnapshot: { taskKey, spsPluginConversation: { pluginKey, sessionId: session.id },
        spsSessionCancellationRequested: true, spsSessionCancellationTermination: "confirmed" },
    }).returning().then(rows => rows[0]!);
    const legacyCommand = await db.insert(spsNodeCommands).values({ companyId: fixture.company.id, nodeId: registered.body.id,
      agentId: fixture.agent.id, heartbeatRunId: legacyParent.id, command: "codex", status: "failed",
      claimedAt: new Date(), startedAt: new Date(), finishedAt: new Date(), error: "Access revoked before closure report",
    }).returning().then(rows => rows[0]!);
    const legacyScope = { ...params, runId: legacyParent.id };
    expect(await scoped.getRun(legacyScope)).toMatchObject({ status: "cancelled", termination: "pending" });
    expect(await scoped.cancel(legacyScope)).toMatchObject({ status: "cancelled", termination: "pending" });
    const legacyPath = `/sps-nodes/${registered.body.id}/commands/${legacyCommand.id}/complete`;
    const legacyReport = { status: "failed", exitCode: 143, signal: "SIGTERM", timedOut: false, error: "actual local closure" };
    await request(app).post(`/api${legacyPath}`)
      .send(createSignedNodeRequest(registered.body.id, node.privateKey, legacyPath, legacyReport)).expect(200);
    expect(await scoped.getRun(legacyScope)).toMatchObject({ status: "cancelled", termination: "confirmed" });
    // Read-only liveness evidence must also override an optimistic stored flag
    // for a recorded local process. This path never calls the cancel effect.
    const liveLocalParent = await db.insert(heartbeatRuns).values({ companyId: fixture.company.id, agentId: fixture.agent.id,
      status: "cancelled", processPid: process.pid,
      contextSnapshot: { taskKey, spsPluginConversation: { pluginKey, sessionId: session.id },
        spsSessionCancellationRequested: true, spsSessionCancellationTermination: "confirmed" },
    }).returning().then(rows => rows[0]!);
    expect(await scoped.getRun({ ...params, runId: liveLocalParent.id })).toMatchObject({ termination: "pending" });
    expect(await scoped.cancel({ ...params, runId: liveLocalParent.id })).toMatchObject({ termination: "pending" });
  });

  it("blocks Node enqueue while paused and keeps stopped commands pending until signed cancellation completion", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    await request(app).put(`/api/sps-nodes/${nodeId}/agent-grants/${fixture.agent.id}`).send({}).expect(200);
    await request(app).put(`/api/agents/${fixture.agent.id}/sps-node-binding`).send({ nodeId }).expect(200);
    const control = spsWorkspaceExecutionControlService(db);
    const paused = await control.transition(fixture.company.id, "pause", fixture.ownerUserId, 0);
    const target = await resolveSpsNodeExecutionTarget({ db, companyId: fixture.company.id, agentId: fixture.agent.id,
      adapterType: "codex_local", heartbeatRunId: null, projectId: null });
    await expect(target!.runner.execute({ command: "codex", args: ["exec"], cwd: ".", env: {} })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.companyId, fixture.company.id))).toHaveLength(0);

    const heartbeat = heartbeatService(db);
    let pendingResult: Promise<unknown> | undefined;
    let pendingResultObserved: Promise<void> | undefined;
    let queued: typeof spsNodeCommands.$inferSelect | null = null;
    let stale: typeof spsNodeCommands.$inferSelect | null = null;
    let nextResult: Promise<unknown> | undefined;
    let nextResultObserved: Promise<void> | undefined;
    let next: typeof spsNodeCommands.$inferSelect | null = null;
    const claimPath = `/sps-nodes/${nodeId}/commands/claim-next`;
    try {
      await control.transition(fixture.company.id, "resume", fixture.ownerUserId, paused.revision);
      pendingResult = target!.runner.execute({ command: "codex", args: ["exec"], cwd: ".", env: {} });
      pendingResultObserved = pendingResult.then(() => undefined, () => undefined);
      for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
        queued = await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.companyId, fixture.company.id)).then(rows => rows[0] ?? null);
        if (!queued) await wait(25);
      }
      expect(queued?.workspaceExecutionEpoch).toBe("0");
      await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
      const stopped = await control.transition(fixture.company.id, "stop", fixture.ownerUserId, paused.revision + 1);
      expect(stopped.pending.commands).toBe(1);
      expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, queued!.id)))[0]?.status).toBe("cancelling");
      const leasePath = `/sps-nodes/${nodeId}/commands/${queued!.id}/lease`;
      await request(app).post(`/api${leasePath}`).send(createSignedNodeRequest(nodeId, node.privateKey, leasePath, {}))
        .expect(200).then(response => expect(response.body).toMatchObject({ active: false, status: "cancelling" }));
      const completePath = `/sps-nodes/${nodeId}/commands/${queued!.id}/complete`;
      const completion = { status: "succeeded", exitCode: 0, timedOut: false };
      const complete = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(nodeId, node.privateKey, completePath, completion)).expect(200);
      expect(complete.body.status).toBe("cancelled");
      expect((await control.get(fixture.company.id)).pending.commands).toBe(0);
      await expect(pendingResult!).rejects.toThrow();

      const resumed = await control.transition(fixture.company.id, "resume", fixture.ownerUserId, stopped.revision);
      stale = await db.insert(spsNodeCommands).values({
        companyId: fixture.company.id, nodeId, agentId: fixture.agent.id, command: "codex", args: ["exec"], env: {},
        workspaceExecutionEpoch: "0", status: "queued", createdAt: new Date("2000-01-01T00:00:00.000Z"),
      }).returning().then(rows => rows[0]!);
      nextResult = target!.runner.execute({ command: "codex", args: ["exec"], cwd: ".", env: {} });
      nextResultObserved = nextResult.then(() => undefined, () => undefined);
      for (let attempt = 0; attempt < 20 && !next; attempt += 1) {
        next = await db.select().from(spsNodeCommands).where(and(eq(spsNodeCommands.companyId, fixture.company.id),
          eq(spsNodeCommands.status, "queued"), eq(spsNodeCommands.workspaceExecutionEpoch, resumed.epoch))).then(rows => rows[0] ?? null);
        if (!next) await wait(25);
      }
      expect(next?.workspaceExecutionEpoch).toBe(resumed.epoch);
      const freshClaim = await request(app).post(`/api${claimPath}`)
        .send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
      expect(freshClaim.body.id).toBe(next!.id);
      expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, stale!.id)))[0]?.status).toBe("failed");
      await db.update(spsNodeCommands).set({ status: "failed", finishedAt: new Date(), error: "fixture cleanup" }).where(eq(spsNodeCommands.id, next!.id));
      await expect(nextResult!).rejects.toThrow();
    } finally {
      await db.update(spsNodeCommands).set({ status: "failed", finishedAt: new Date(), error: "fixture cleanup" })
        .where(and(eq(spsNodeCommands.companyId, fixture.company.id), inArray(spsNodeCommands.status, ["queued", "claimed", "running", "cancelling"])));
      heartbeat.disposeWorkspaceExecutionStopHandler();
      if (pendingResultObserved) await pendingResultObserved;
      if (nextResultObserved) await nextResultObserved;
    }
  }, 30_000);

  it("accepts a signed cancellation acknowledgement after stop commits but before its fanout updates the Node row", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    await request(app).put(`/api/sps-nodes/${nodeId}/agent-grants/${fixture.agent.id}`).send({}).expect(200);
    await request(app).put(`/api/agents/${fixture.agent.id}/sps-node-binding`).send({ nodeId }).expect(200);
    const target = await resolveSpsNodeExecutionTarget({ db, companyId: fixture.company.id, agentId: fixture.agent.id,
      adapterType: "codex_local", heartbeatRunId: null, projectId: null });
    const pendingResult = target!.runner.execute({ command: "codex", args: ["exec"], cwd: ".", env: {} });
    const pendingResultObserved = pendingResult.then(() => undefined, () => undefined);
    let queued: typeof spsNodeCommands.$inferSelect | null = null;
    for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
      queued = await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.companyId, fixture.company.id)).then(rows => rows[0] ?? null);
      if (!queued) await wait(25);
    }
    expect(queued).not.toBeNull();
    const claimPath = `/sps-nodes/${nodeId}/commands/claim-next`;
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
    let fanoutStarted!: () => void, releaseFanout!: () => void;
    const started = new Promise<void>(resolve => { fanoutStarted = resolve; });
    const fanout = new Promise<void>(resolve => { releaseFanout = resolve; });
    const unregister = registerSpsWorkspaceExecutionStopHandler(db, "heartbeat-runs", async () => { fanoutStarted(); await fanout; });
    let stop: Promise<unknown> | undefined;
    try {
      const control = spsWorkspaceExecutionControlService(db);
      stop = control.transition(fixture.company.id, "stop", fixture.ownerUserId, 0);
      await started;
      expect((await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, queued!.id)))[0]?.status).toBe("cancelling");
      const completePath = `/sps-nodes/${nodeId}/commands/${queued!.id}/complete`;
      const completion = { status: "succeeded", exitCode: 0, timedOut: false };
      const complete = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(nodeId, node.privateKey, completePath, completion)).expect(200);
      expect(complete.body.status).toBe("cancelled");
      releaseFanout();
      await stop;
      await expect(pendingResult).rejects.toThrow();
    } finally {
      releaseFanout();
      unregister();
      if (stop) await stop.catch(() => undefined);
      await db.update(spsNodeCommands).set({ status: "failed", finishedAt: new Date(), error: "fixture cleanup" })
        .where(and(eq(spsNodeCommands.companyId, fixture.company.id), inArray(spsNodeCommands.status, ["queued", "claimed", "running", "cancelling"])));
      await pendingResultObserved;
    }
  }, 30_000);

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

  it("rechecks the Node Workspace Source grant on every plugin-run lease", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, nodeId))
      .then(rows => rows.find(row => row.kind === "codex_cli")!);
    const source = await db.insert(spsWorkspaceSources).values({ companyId: fixture.company.id,
      displayName: "Granted Source", sharePath: "\\\\host.example.ts.net\\SPS_source", createdByUserId: fixture.ownerUserId })
      .returning().then(rows => rows[0]!);
    const sourceGrant = await db.insert(spsWorkspaceSourceNodeGrants).values({ companyId: fixture.company.id,
      sourceId: source.id, nodeId, credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: Buffer.alloc(128, 8).toString("base64"),
      grantedByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const siblingSource = await db.insert(spsWorkspaceSources).values({ companyId: fixture.company.id,
      displayName: "Sibling Source", sharePath: "\\\\host.example.ts.net\\SPS_sibling", createdByUserId: fixture.ownerUserId })
      .returning().then(rows => rows[0]!);
    const siblingSourceGrant = await db.insert(spsWorkspaceSourceNodeGrants).values({ companyId: fixture.company.id,
      sourceId: siblingSource.id, nodeId, credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: Buffer.alloc(128, 9).toString("base64"),
      grantedByUserId: fixture.ownerUserId }).returning().then(rows => rows[0]!);
    const execution = spsPluginExecutionService(db, "sps.source-grant-test");
    const grant = await execution.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "source-worker",
      nodeId, runnerProfileId: runner.id, workspaceSourceId: source.id });
    const siblingExecutionGrant = await execution.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "source-worker",
      nodeId, runnerProfileId: runner.id, workspaceSourceId: siblingSource.id });
    const run = await execution.dispatchRun({ companyId: fixture.company.id, executionGrantId: grant.id, args: ["exec"] });
    const claimPath = `/sps-nodes/${nodeId}/plugin-runs/claim-next`;
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
    const siblingRun = await execution.dispatchRun({ companyId: fixture.company.id, executionGrantId: siblingExecutionGrant.id, args: ["exec"] });
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);

    await db.update(spsWorkspaceSourceNodeGrants).set({ revokedAt: new Date() })
      .where(eq(spsWorkspaceSourceNodeGrants.id, sourceGrant.id));
    const leasePath = `/sps-nodes/${nodeId}/plugin-runs/${run.id}/lease`;
    const lease = await request(app).post(`/api${leasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, leasePath, {})).expect(200);
    expect(lease.body).toMatchObject({ active: false, status: "failed" });
    const siblingLeasePath = `/sps-nodes/${nodeId}/plugin-runs/${siblingRun.id}/lease`;
    const siblingLease = await request(app).post(`/api${siblingLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, siblingLeasePath, {})).expect(200);
    expect(siblingLease.body).toMatchObject({ active: true, status: "claimed" });

    await db.update(spsWorkspaceSources).set({ sharePath: "\\\\host.example.ts.net\\SPS_sibling_replaced" })
      .where(eq(spsWorkspaceSources.id, siblingSource.id));
    const staleRouteLease = await request(app).post(`/api${siblingLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, siblingLeasePath, {})).expect(200);
    expect(staleRouteLease.body).toMatchObject({ active: false, status: "failed" });
    expect(await db.select().from(spsWorkspaceSourceNodeGrants).where(eq(spsWorkspaceSourceNodeGrants.id, siblingSourceGrant.id)))
      .toMatchObject([{ revokedAt: null }]);
    const credentialRun = await execution.dispatchRun({ companyId: fixture.company.id, executionGrantId: siblingExecutionGrant.id, args: ["exec"] });
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
    await db.update(spsWorkspaceSourceNodeGrants).set({ credentialAlgorithm: "unsupported" })
      .where(eq(spsWorkspaceSourceNodeGrants.id, siblingSourceGrant.id));
    const credentialLeasePath = `/sps-nodes/${nodeId}/plugin-runs/${credentialRun.id}/lease`;
    const credentialLease = await request(app).post(`/api${credentialLeasePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, credentialLeasePath, {})).expect(200);
    expect(credentialLease.body).toMatchObject({ active: false, status: "failed" });
    const eventPath = `/sps-nodes/${nodeId}/plugin-runs/${run.id}/events`;
    await request(app).post(`/api${eventPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, eventPath,
      { sequence: 1, stream: "stdout", body: "must be rejected after grant revocation" })).expect(403);
    expect(await execution.getRun({ companyId: fixture.company.id, runId: run.id })).toMatchObject({ status: "failed" });
  });

  it("lists only owned runs and cancels active runs only after signed Node completion", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/heartbeat`).send(createSignedHeartbeat(registered.body.id, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({}).expect(200);
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, registered.body.id))
      .then(rows => rows.find(row => row.kind === "codex_cli")!);
    const service = spsPluginExecutionService(db, "sps.management-test");
    const other = spsPluginExecutionService(db, "sps.other-plugin");
    const grant = await service.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "test", nodeId: registered.body.id, runnerProfileId: runner.id });
    const dispatch = () => service.dispatchRun({ companyId: fixture.company.id, executionGrantId: grant.id, args: ["exec", "test"] });
    const queued = await dispatch();
    const active = await dispatch();
    expect(await other.listRuns({ companyId: fixture.company.id })).toEqual([]);
    await expect(other.cancelRun({ companyId: fixture.company.id, runId: active.id })).rejects.toThrow("not found");
    await expect(service.cancelRun({ companyId: randomUUID(), runId: active.id })).rejects.toThrow("not found");
    await expect(service.listRuns({ companyId: fixture.company.id, limit: Infinity })).rejects.toThrow("limit");
    await expect(service.listRuns({ companyId: fixture.company.id, status: "unknown" })).rejects.toThrow("status");
    const first = await service.listRuns({ companyId: fixture.company.id, limit: 1 });
    const next = await service.listRuns({ companyId: fixture.company.id, limit: 1, beforeId: first[0].id });
    expect(new Set([first[0].id, next[0].id])).toEqual(new Set([queued.id, active.id]));
    expect(first[0]).not.toHaveProperty("env");
    expect(first[0]).not.toHaveProperty("stdin");
    const cancelled = await service.cancelRun({ companyId: fixture.company.id, runId: queued.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).not.toBeNull();
    const claimPath = `/sps-nodes/${registered.body.id}/plugin-runs/claim-next`;
    const claimed = await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {})).expect(200);
    expect(claimed.body.id).toBe(active.id);
    const requested = await service.cancelRun({ companyId: fixture.company.id, runId: active.id });
    expect(requested).toMatchObject({ status: "cancelling", finishedAt: null });
    expect(await service.cancelRun({ companyId: fixture.company.id, runId: active.id })).toEqual(requested);
    const leasePath = `/sps-nodes/${registered.body.id}/plugin-runs/${active.id}/lease`;
    const lease = await request(app).post(`/api${leasePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, leasePath, {})).expect(200);
    expect(lease.body).toMatchObject({ active: false, status: "cancelling" });
    const eventPath = `/sps-nodes/${registered.body.id}/plugin-runs/${active.id}/events`;
    await request(app).post(`/api${eventPath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, eventPath, { sequence: 1, stream: "stdout", body: "late" })).expect(403);
    expect((await service.getRun({ companyId: fixture.company.id, runId: active.id })).status).toBe("cancelling");
    const completePath = `/sps-nodes/${registered.body.id}/plugin-runs/${active.id}/complete`;
    const completed = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath,
      { status: "failed", exitCode: 1, signal: "SIGTERM", timedOut: false, error: "lease revoked" })).expect(200);
    expect(completed.body).toMatchObject({ status: "cancelled", exitCode: 1, signal: "SIGTERM" });
    expect(completed.body.finishedAt).not.toBeNull();
    const duplicate = await request(app).post(`/api${completePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, completePath,
      { status: "succeeded", exitCode: 0, timedOut: false })).expect(200);
    expect(duplicate.body).toEqual(completed.body);
    expect((await service.cancelRun({ companyId: fixture.company.id, runId: active.id })).status).toBe("cancelled");
    expect(await service.listRuns({ companyId: fixture.company.id, status: "cancelled", subjectKey: "test" })).toHaveLength(2);
    const racing = await dispatch();
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, claimPath, {})).expect(200);
    const racingEventPath = `/sps-nodes/${registered.body.id}/plugin-runs/${racing.id}/events`;
    const [lateOutput] = await Promise.all([
      request(app).post(`/api${racingEventPath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, racingEventPath,
        { sequence: 1, stream: "stdout", body: "concurrent output" })),
      service.cancelRun({ companyId: fixture.company.id, runId: racing.id }),
    ]);
    expect([204, 403]).toContain(lateOutput.status);
    expect((await service.getRun({ companyId: fixture.company.id, runId: racing.id })).status).toBe("cancelling");
    const raceCompletePath = `/sps-nodes/${registered.body.id}/plugin-runs/${racing.id}/complete`;
    await request(app).post(`/api${raceCompletePath}`).send(createSignedNodeRequest(registered.body.id, node.privateKey, raceCompletePath,
      { status: "succeeded", exitCode: 0, timedOut: false })).expect(200);
    expect((await service.getRun({ companyId: fixture.company.id, runId: racing.id })).status).toBe("cancelled");
  });

  it("bounds execution timeouts and never redispatches an uncertain silent claim", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, nodeId))
      .then(rows => rows.find(row => row.kind === "codex_cli")!);
    const service = spsPluginExecutionService(db, "sps.limit-test");
    const grant = await service.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "execution", nodeId, runnerProfileId: runner.id });
    const dispatch = (timeoutMs?: number | null) => service.dispatchRun({ companyId: fixture.company.id, executionGrantId: grant.id, args: [], timeoutMs });
    for (const timeout of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1000", true, {}]) {
      await expect(dispatch(timeout as number)).rejects.toThrow("timeout");
    }
    expect(await service.listRuns({ companyId: fixture.company.id })).toHaveLength(0);
    const first = await dispatch(1);
    const [stored] = await db.select().from(spsPluginNodeRuns).where(eq(spsPluginNodeRuns.id, first.id));
    expect(stored.timeoutMs).toBe(1000);
    const claimPath = `/sps-nodes/${nodeId}/plugin-runs/claim-next`;
    const claim = () => request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {}));
    const concurrent = await Promise.all([claim(), claim(), claim()]);
    expect(concurrent.filter(result => result.status === 200).map(result => result.body.id)).toEqual([first.id]);
    expect(concurrent.filter(result => result.status === 204)).toHaveLength(2);
    const old = new Date(Date.now() - 30 * 60000);
    await db.update(spsPluginNodeRuns).set({ claimedAt: old, startedAt: old, updatedAt: old }).where(eq(spsPluginNodeRuns.id, first.id));
    await claim().expect(204);
    expect(await service.getRun({ companyId: fixture.company.id, runId: first.id })).toMatchObject({ status: "claimed", finishedAt: null });
    const leasePath = `/sps-nodes/${nodeId}/plugin-runs/${first.id}/lease`;
    await request(app).post(`/api${leasePath}`).send(createSignedNodeRequest(nodeId, node.privateKey, leasePath, {})).expect(200)
      .expect(({ body }) => expect(body.active).toBe(true));
    await service.cancelRun({ companyId: fixture.company.id, runId: first.id });
    await claim().expect(204);
    expect(await service.getRun({ companyId: fixture.company.id, runId: first.id })).toMatchObject({ status: "cancelling", finishedAt: null });
    const completionPath = `/sps-nodes/${nodeId}/plugin-runs/${first.id}/complete`;
    await request(app).post(`/api${completionPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, completionPath,
      { status: "failed", exitCode: null, signal: "SIGTERM", timedOut: false })).expect(200);
    expect((await service.getRun({ companyId: fixture.company.id, runId: first.id })).status).toBe("cancelled");
    await claim().expect(204); // No implicit retry even after termination acknowledgement.

    const invalid = await dispatch();
    await db.update(spsPluginNodeRuns).set({ timeoutMs: 0 }).where(eq(spsPluginNodeRuns.id, invalid.id));
    const bounded = await dispatch(24 * 60 * 60 * 1000);
    const boundedClaim = await claim().expect(200);
    expect(boundedClaim.body).toMatchObject({ id: bounded.id, timeoutMs: 4 * 60 * 60 * 1000 });
    expect((await service.getRun({ companyId: fixture.company.id, runId: invalid.id })).status).toBe("failed");
    const defaultRun = await dispatch(null);
    expect((await claim().expect(200)).body).toMatchObject({ id: defaultRun.id, timeoutMs: null });
  });

  it("accepts signed Node usage exactly once with the terminal write and exposes it only to the owning Plugin", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    node.payload.capabilities.push({ kind: "claude_cli", label: "Claude", version: "fixture", models: [] });
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    const nodeId = registered.body.id;
    await request(app).post(`/api/sps-nodes/${nodeId}/heartbeat`).send(createSignedHeartbeat(nodeId, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${nodeId}/approve`).send({}).expect(200);
    const runners = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, nodeId));
    const pluginKey = "sps.node-usage", service = spsPluginExecutionService(db, pluginKey);
    const grant = await service.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "worker", nodeId, runnerProfileId: runners.find(row => row.kind === "claude_cli")!.id });
    const history = spsExecutionHistoryService(db, pluginKey);
    const usageReport = { schemaVersion: 1, source: "claude_model_usage_v1", inputTokens: 0, cachedInputTokens: null, outputTokens: 12 };
    const claimPath = `/sps-nodes/${nodeId}/plugin-runs/claim-next`;
    const dispatch = async () => {
      const run = await service.dispatchRun({ companyId: fixture.company.id, executionGrantId: grant.id, args: ["--output-format", "stream-json"] });
      await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
      return run;
    };
    const first = await dispatch(), path = `/sps-nodes/${nodeId}/plugin-runs/${first.id}/complete`;
    const completion = { status: "succeeded", exitCode: 0, timedOut: false, usageReport };
    const signed = createSignedNodeRequest(nodeId, node.privateKey, path, completion);
    await request(app).post(`/api${path}`).send({ ...signed, usageReport: { ...usageReport, outputTokens: 999 } }).expect(403);
    const accepted = await request(app).post(`/api${path}`).send(createSignedNodeRequest(nodeId, node.privateKey, path, completion)).expect(200);
    expect(accepted.body.usageJson.spsNodeUsageReceipt).toBeTruthy();
    const duplicate = await request(app).post(`/api${path}`).send(createSignedNodeRequest(nodeId, node.privateKey, path,
      { ...completion, usageReport: { ...usageReport, outputTokens: 999 } })).expect(200);
    expect(duplicate.body.usageJson).toEqual(accepted.body.usageJson);
    expect(await history.get(fixture.company.id, "node", first.id)).toMatchObject({ usage: {
      inputTokens: { value: 0, provenance: "reported" }, outputTokens: { value: 12, provenance: "reported" },
      cachedInputTokens: { value: null, provenance: "unavailable" }, costUsd: { value: null, provenance: "unavailable" },
    } });
    expect(await spsExecutionHistoryService(db, "sps.other").get(fixture.company.id, "node", first.id)).toBeNull();
    expect(await history.get(randomUUID(), "node", first.id)).toBeNull();
    const now = new Date(), from = new Date(now.getTime() - 3600000).toISOString(), to = new Date(now.getTime() + 3600000).toISOString();
    expect(await history.summarize(fixture.company.id, { from, to })).toMatchObject({ executionCount: 1,
      tokens: { inputTokens: { reported: 0 }, outputTokens: { reported: 12 } } });

    const cancelled = await dispatch(), cancelledPath = `/sps-nodes/${nodeId}/plugin-runs/${cancelled.id}/complete`;
    await service.cancelRun({ companyId: fixture.company.id, runId: cancelled.id });
    await request(app).post(`/api${cancelledPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, cancelledPath, completion)).expect(200);
    expect(await history.get(fixture.company.id, "node", cancelled.id)).toMatchObject({ status: "cancelled", usage: { outputTokens: { value: 12 } } });

    const oldNode = await dispatch(), oldPath = `/sps-nodes/${nodeId}/plugin-runs/${oldNode.id}/complete`;
    const { usageReport: _unused, ...legacyCompletion } = completion;
    await request(app).post(`/api${oldPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, oldPath, legacyCompletion)).expect(200);
    expect(await history.get(fixture.company.id, "node", oldNode.id)).toMatchObject({ usage: { inputTokens: { value: null } } });

    const race = await dispatch(), racePath = `/sps-nodes/${nodeId}/plugin-runs/${race.id}/complete`;
    for (const invalid of [null, { ...usageReport, outputTokens: -1 }, { ...usageReport, secret: "not allowed" }]) {
      await request(app).post(`/api${racePath}`).send(createSignedNodeRequest(nodeId, node.privateKey, racePath, { ...completion, usageReport: invalid })).expect(400);
    }
    const raced = await Promise.all([14, 15].map(outputTokens => request(app).post(`/api${racePath}`)
      .send(createSignedNodeRequest(nodeId, node.privateKey, racePath, { ...completion, usageReport: { ...usageReport, outputTokens } })).expect(200)));
    expect(raced[0].body.usageJson).toEqual(raced[1].body.usageJson);
    expect([14, 15]).toContain((await history.get(fixture.company.id, "node", race.id))?.usage.outputTokens.value);

    const revoked = await dispatch(), revokedPath = `/sps-nodes/${nodeId}/plugin-runs/${revoked.id}/complete`;
    await service.revokeExecutionGrant({ companyId: fixture.company.id, grantId: grant.id });
    await request(app).post(`/api${revokedPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, revokedPath, completion)).expect(200);
    expect(await history.get(fixture.company.id, "node", revoked.id)).toMatchObject({ status: "failed", usage: { outputTokens: { value: null } } });

    const codexGrant = await service.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "unsupported", nodeId, runnerProfileId: runners.find(row => row.kind === "codex_cli")!.id });
    const unsupported = await service.dispatchRun({ companyId: fixture.company.id, executionGrantId: codexGrant.id, args: [] });
    await request(app).post(`/api${claimPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, claimPath, {})).expect(200);
    const unsupportedPath = `/sps-nodes/${nodeId}/plugin-runs/${unsupported.id}/complete`;
    await request(app).post(`/api${unsupportedPath}`).send(createSignedNodeRequest(nodeId, node.privateKey, unsupportedPath, completion)).expect(400);
    expect((await service.getRun({ companyId: fixture.company.id, runId: unsupported.id })).status).toBe("claimed");
  });

  it("paginates both execution lanes at millisecond precision and preserves own-plugin historical scope", async () => {
    const fixture = await createCompanyFixture(db);
    const app = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner"));
    const node = createNodePayload();
    const registered = await request(app).post(`/api/companies/${fixture.company.id}/sps-nodes`).send(node.payload).expect(201);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/heartbeat`).send(createSignedHeartbeat(registered.body.id, node.privateKey)).expect(200);
    await request(app).post(`/api/sps-nodes/${registered.body.id}/approve`).send({}).expect(200);
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, registered.body.id)).then(rows => rows.find(row => row.kind === "codex_cli")!);
    const pluginKey = "sps.history_test";
    const execution = spsPluginExecutionService(db, pluginKey);
    const grant = await execution.upsertExecutionGrant({ companyId: fixture.company.id, subjectKey: "test", nodeId: registered.body.id, runnerProfileId: runner.id });
    const remote = await execution.dispatchRun({ companyId: fixture.company.id, executionGrantId: grant.id, args: ["secret argument"], env: { TOKEN: "secret value" }, stdin: "secret prompt" });
    const sessionId = randomUUID();
    const context = { taskKey: `plugin:${pluginKey}:session:history`, spsPluginConversation: { pluginKey, sessionId, message: "secret prompt" }, spsExecutionRuntime: { adapterType: "codex_local" } };
    const insertRun = (id: string, contextSnapshot = context) => db.insert(heartbeatRuns).values({ id, companyId: fixture.company.id, agentId: fixture.agent.id, invocationSource: "on_demand", status: "succeeded", contextSnapshot,
      usageJson: { model: "gpt-6-luna", spsUsageEvidence: buildSpsUsageEvidence({ usage: { inputTokens: 12, outputTokens: 4 }, usageBasis: "per_run", billingType: "subscription_included" }) } });
    await insertRun(remote.id); // A tie across the two independent primary-key spaces.
    const secondId = randomUUID();
    await insertRun(secondId);
    const receiptScope = { companyId: fixture.company.id, runId: secondId, agentId: fixture.agent.id, pluginKey, sessionId };
    const receipt = createSpsExecutionUsageReceipt(receiptScope, buildSpsUsageEvidence({ usage: { inputTokens: 12, outputTokens: 4 }, usageBasis: "per_run", billingType: "subscription_included" }));
    const receiptUsage = { spsUsageReceipt: receipt, spsUsageEvidence: buildSpsUsageEvidence({ usage: { inputTokens: 999 }, usageBasis: "per_run" }) };
    await db.update(heartbeatRuns).set({ usageJson: receiptUsage }).where(eq(heartbeatRuns.id, secondId));
    const sameMillisecond = "2026-10-22T02:03:04.123";
    await db.update(heartbeatRuns).set({ createdAt: sql`${sameMillisecond + "901Z"}::timestamptz` });
    await db.update(spsPluginNodeRuns).set({ createdAt: sql`${sameMillisecond + "001Z"}::timestamptz` });
    await insertRun(randomUUID(), { ...context, spsPluginConversation: { ...context.spsPluginConversation, pluginKey: "sps.other" } });
    await insertRun(randomUUID(), { ...context, taskKey: "plugin:sps.historyXtest:session:not-owned" });
    await insertRun(randomUUID(), { ...context, spsPluginConversation: { ...context.spsPluginConversation, sessionId: "invalid" as typeof sessionId } });
    const history = spsExecutionHistoryService(db, pluginKey);
    const all = await history.list(fixture.company.id);
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    expect(all.items.map(item => item.sessionId).filter(Boolean)).toEqual([sessionId, sessionId]);
    expect(all.items.filter(item => item.lane === "agent_session").every(item => item.usage.inputTokens.value === 12)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("secret");
    const summaryWindow = { from: "2026-10-22T00:00:00.000Z", to: "2026-10-23T00:00:00.000Z" };
    const summary = await history.summarize(fixture.company.id, summaryWindow);
    expect(summary).toMatchObject({ executionCount: 3, terminalCount: 2, inFlightCount: 1,
      tokens: { inputTokens: { reported: 24, reportedExecutions: 2, unavailableExecutions: 1 } },
      costs: { subscriptionReference: { reported: null, unavailableExecutions: 2 }, other: { reported: null, unavailableExecutions: 1 } } });
    const again = await history.summarize(fixture.company.id, summaryWindow);
    expect(again.tokens).toEqual(summary.tokens); // Read repetition never appends charges.
    const [registryPlugin] = await db.insert(plugins).values({
      pluginKey, packageName: "@sps/history-fixture", version: "0.0.1", status: "disabled",
      manifestJson: { id: pluginKey, apiVersion: 1, version: "0.0.1", displayName: "History fixture", description: "History fixture", author: "SPS", categories: [], capabilities: [], entrypoints: { worker: "./worker.js" } },
    }).returning();
    const hostApp = await createApp(db, boardActor(fixture.company.id, fixture.ownerUserId, "owner", { source: "local_implicit" }));
    const historyEndpoint = `/api/companies/${fixture.company.id}/sps-executions`;
    const hostPages: PluginSpsExecutionPage["items"] = [];
    let hostCursor: PluginSpsExecutionCursor | null = null;
    do {
      const response: { headers: Record<string, string | string[] | undefined>; body: PluginSpsExecutionPage } = await request(hostApp).get(historyEndpoint).query({ pluginId: registryPlugin.id, limit: 1,
        ...(hostCursor ? { beforeCreatedAt: hostCursor.createdAt, beforeRunId: hostCursor.runId, beforeLane: hostCursor.lane } : {}) }).expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(response.body)).not.toContain("secret");
      hostPages.push(...response.body.items);
      hostCursor = response.body.nextCursor;
    } while (hostCursor && hostPages.length < 6);
    expect(hostPages).toEqual(all.items);
    const hostNodePage = await request(hostApp).get(historyEndpoint).query({ pluginId: registryPlugin.id, lane: "node" }).expect(200);
    expect(hostNodePage.body.items.map((run: { lane: string }) => run.lane)).toEqual(["node"]);
    const hostDetail = await request(hostApp).get(`${historyEndpoint}/agent_session/${secondId}`).query({ pluginId: registryPlugin.id }).expect(200);
    expect(hostDetail.headers["cache-control"]).toBe("no-store");
    expect(hostDetail.body.usage.inputTokens).toMatchObject({ value: 12, provenance: "reported" });
    expect(JSON.stringify(hostDetail.body)).not.toContain("secret");
    await request(hostApp).get(`${historyEndpoint}/node/${randomUUID()}`).query({ pluginId: registryPlugin.id }).expect(404);
    const endpoint = `/api/companies/${fixture.company.id}/sps-executions/summary`;
    const apiSummary = await request(hostApp).get(endpoint).query({ pluginId: registryPlugin.id, ...summaryWindow }).expect(200);
    expect(apiSummary.body.tokens).toEqual(summary.tokens);
    expect(apiSummary.body.executionCount).toBe(3);
    expect(apiSummary.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(apiSummary.body)).not.toContain("secret");
    const repeatSummary = await request(hostApp).get(endpoint).query({ pluginId: registryPlugin.id, ...summaryWindow }).expect(200);
    expect(repeatSummary.body.tokens).toEqual(summary.tokens);
    const unrelatedPlugin = await db.insert(plugins).values({
      pluginKey: "sps.history-empty", packageName: "@sps/history-empty", version: "0.0.1",
      manifestJson: { id: "sps.history-empty", apiVersion: 1, version: "0.0.1", displayName: "Empty fixture", description: "Empty history fixture", author: "SPS", categories: [], capabilities: [], entrypoints: { worker: "./worker.js" } },
    }).returning().then(rows => rows[0]!);
    const emptySummary = await request(hostApp).get(endpoint).query({ pluginId: unrelatedPlugin.id, ...summaryWindow }).expect(200);
    expect(emptySummary.body.executionCount).toBe(0);
    expect(emptySummary.body.tokens.inputTokens.reported).toBeNull();
    const unrelatedHistory = await request(hostApp).get(historyEndpoint).query({ pluginId: unrelatedPlugin.id }).expect(200);
    expect(unrelatedHistory.body.items).toEqual([]);
    await request(hostApp).get(`${historyEndpoint}/agent_session/${secondId}`).query({ pluginId: unrelatedPlugin.id }).expect(404);
    expect((await history.summarize(fixture.company.id, { ...summaryWindow, agentId: fixture.agent.id })).executionCount).toBe(2);
    expect((await history.summarize(fixture.company.id, { ...summaryWindow, lane: "node" })).executionCount).toBe(1);
    expect((await history.summarize(fixture.company.id, { from: sameMillisecond + "Z", to: "2026-10-22T02:03:04.124Z" })).executionCount).toBe(3);
    expect((await history.summarize(fixture.company.id, { from: summaryWindow.from, to: sameMillisecond + "Z" })).executionCount).toBe(0);
    expect((await history.summarize(randomUUID(), summaryWindow)).executionCount).toBe(0);
    expect((await spsExecutionHistoryService(db, "other").summarize(fixture.company.id, summaryWindow)).executionCount).toBe(0);
    await expect(history.summarize(fixture.company.id, { ...summaryWindow, to: summaryWindow.from })).rejects.toThrow("window");
    const pages = [];
    let before;
    do {
      const page = await history.list(fixture.company.id, { limit: 1, before });
      pages.push(...page.items); before = page.nextCursor ?? undefined;
    } while (before && pages.length < 6);
    expect(pages).toEqual(all.items);
    expect(new Set(pages.map(item => `${item.lane}:${item.runId}`)).size).toBe(3);
    expect((await history.list(fixture.company.id, { lane: "node" })).items).toHaveLength(1);
    expect((await history.list(fixture.company.id, { lane: "agent_session" })).items).toHaveLength(2);
    expect(await history.get(fixture.company.id, "agent_session", remote.id)).toMatchObject({ sessionId }); // No live session row required.
    expect(await history.get(fixture.company.id, "agent_session", secondId)).toMatchObject({ usage: { inputTokens: { value: 12, provenance: "reported" } } });
    await db.update(heartbeatRuns).set({ usageJson: { ...receiptUsage, spsUsageReceipt: { ...receipt, digest: "0".repeat(64) } } }).where(eq(heartbeatRuns.id, secondId));
    expect(await history.get(fixture.company.id, "agent_session", secondId)).toMatchObject({ usage: { inputTokens: { value: null, provenance: "unavailable" } } });
    expect((await history.summarize(fixture.company.id, summaryWindow)).tokens.inputTokens).toMatchObject({ reported: 12, reportedExecutions: 1, unavailableExecutions: 2 });
    await db.update(heartbeatRuns).set({ usageJson: receiptUsage }).where(eq(heartbeatRuns.id, secondId));
    expect(await history.get(randomUUID(), "node", remote.id)).toBeNull();
    expect(await spsExecutionHistoryService(db, "other").get(fixture.company.id, "agent_session", remote.id)).toBeNull();
    expect((await spsExecutionHistoryService(db, "other").list(fixture.company.id)).items).toEqual([]);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) await expect(history.list(fixture.company.id, { limit })).rejects.toThrow("limit");
    await expect(history.list(fixture.company.id, { lane: "invalid" as never })).rejects.toThrow("lane");
    for (const cursor of [{ createdAt: "bad", runId: remote.id, lane: "node" }, { ...all.items[0], extra: true }, { createdAt: "2026-10-22T02:03:04Z", runId: remote.id, lane: "node" }]) {
      await expect(history.list(fixture.company.id, { before: cursor as never })).rejects.toThrow("cursor");
    }
    await expect(history.get(fixture.company.id, "node", "bad")).rejects.toThrow("UUID");
    for (let start = 0; start < 10001; start += 500) {
      await db.insert(heartbeatRuns).values(Array.from({ length: Math.min(500, 10001 - start) }, () => ({
        companyId: fixture.company.id, agentId: fixture.agent.id, invocationSource: "on_demand", status: "succeeded",
        contextSnapshot: context, createdAt: new Date("2026-10-21T12:00:00.000Z"),
      })));
    }
    await expect(history.summarize(fixture.company.id, { from: "2026-10-21T00:00:00.000Z", to: summaryWindow.from })).rejects.toThrow("narrow the time window");
    await request(hostApp).get(endpoint).query({ pluginId: registryPlugin.id, from: "2026-10-21T00:00:00.000Z", to: summaryWindow.from }).expect(422);
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
