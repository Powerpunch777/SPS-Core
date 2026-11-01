import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, projects, spsNodes,
  spsHostProjectShares, spsHostProjectShareNodeGrants, spsWorkspaceSources,
  spsWorkspaceSourceNodeGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { createSpsPluginArtifactReferenceReader } from "../services/sps-plugin-artifact-references.js";
import { readSpsSourceArtifactInventory } from "../services/sps-source-artifact-inventory.js";
import { companyService } from "../services/companies.js";
import { projectService } from "../services/projects.js";
import { spsNodeRoutes } from "../routes/sps-nodes.js";
import { spsWorkspaceSourceRoutes } from "../routes/sps-workspace-sources.js";
import { companyRoutes } from "../routes/companies.js";
import { projectRoutes } from "../routes/projects.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const TOKEN = "isolated-source-artifact-admission";
const envelope = { credentialAlgorithm: "rsa-oaep-sha256", credentialEnvelope: "A".repeat(128) };
type Db = ReturnType<typeof createDb>;

describeDatabase("actual Source mutation admission with owned Core inventory", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db, root: string;
  const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
  const previousBaseline = process.env.SPS_CORE_BASELINE_MODE;
  beforeAll(async () => {
    process.env.SPS_DESKTOP_ACCESS_TOKEN = TOKEN;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    root = await mkdtemp(join(tmpdir(), "sps-source-mutation-"));
    database = await startEmbeddedPostgresTestDatabase("sps-source-mutation-db-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    try { await database?.cleanup(); }
    finally {
      if (root) await rm(root, { recursive: true, force: true });
      if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
      if (previousBaseline === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previousBaseline;
    }
  });

  async function fixture() {
    const workspace = await db.insert(companies).values({ name: "Source mutation fixture",
      issuePrefix: `SM${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}` }).returning().then(rows => rows[0]!);
    const member = await db.insert(companyMemberships).values({ companyId: workspace.id, principalType: "user",
      principalId: `member-${randomUUID()}`, membershipRole: "operator", status: "active" }).returning().then(rows => rows[0]!);
    const project = await db.insert(projects).values({ companyId: workspace.id, name: "Source project" }).returning().then(rows => rows[0]!);
    const node = await db.insert(spsNodes).values({ companyId: workspace.id, ownerUserId: member.principalId,
      displayName: "Fixture Node", publicKey: `fixture-${randomUUID()}`, transportPublicKey: "fixture-transport",
      status: "active", platform: "windows", keyVerifiedAt: new Date() }).returning().then(rows => rows[0]!);
    const source = await db.insert(spsWorkspaceSources).values({ companyId: workspace.id,
      displayName: "Source", sharePath: "\\\\fixture.example\\Workspace", status: "active", createdByUserId: "fixture" })
      .returning().then(rows => rows[0]!);
    const share = await db.insert(spsHostProjectShares).values({ companyId: workspace.id, projectId: project.id,
      sharePath: "\\\\fixture.example\\Project", status: "active", createdByUserId: "fixture" }).returning().then(rows => rows[0]!);
    await db.insert(spsWorkspaceSourceNodeGrants).values({ companyId: workspace.id, sourceId: source.id,
      nodeId: node.id, ...envelope, grantedByUserId: "fixture" });
    await db.insert(spsHostProjectShareNodeGrants).values({ companyId: workspace.id, shareId: share.id,
      nodeId: node.id, ...envelope, grantedByUserId: "fixture" });
    const maintenance = createSpsPluginArtifactMaintenance();
    const reader = createSpsPluginArtifactReferenceReader({ localPluginDir: root, maintenance, readers: {
      listPlugins: async () => [], listPending: async () => [], listRetainedReviews: async () => [],
      readWorkers: () => [], readPreparations: () => [], readRegistryStages: async () => [],
      readSourceInventory: () => readSpsSourceArtifactInventory(db),
    } });
    const workspaceMutation = vi.fn();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-host", source: "local_implicit", companyIds: [workspace.id], isInstanceAdmin: true };
      next();
    });
    app.use("/api", spsWorkspaceSourceRoutes(db, { artifactMaintenance: maintenance }));
    app.use("/api", spsNodeRoutes(db, { artifactMaintenance: maintenance }));
    app.use("/api/companies", companyRoutes(db, undefined, {
      artifactMaintenance: maintenance, workspaceWorkers: {
        async withWorkspaceMutation<T>(workspaceId: string, action: () => Promise<T>) {
          workspaceMutation(workspaceId);
          return action();
        },
      },
    }));
    app.use("/api", projectRoutes(db, { artifactMaintenance: maintenance }));
    app.use((error: { status?: number; message?: string; details?: unknown }, _req: express.Request,
      res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message, details: error.details });
    });
    const host = (method: "get" | "post" | "patch" | "put" | "delete", url: string) => request(app)[method](url)
      .set("Host", "127.0.0.1").set("x-sps-desktop-access", TOKEN).set("x-sps-desktop-owner-bootstrap", TOKEN);
    return { workspace, member, project, node, source, share, maintenance, reader, workspaceMutation, app, host };
  }

  it("rejects all Source/share/grant and Node/member mutations during the actual held reference scope", async () => {
    const f = await fixture();
    const sourceUrl = `/api/companies/${f.workspace.id}/sps-workspace-sources`;
    const shareUrl = `/api/projects/${f.project.id}/sps-host-share`;
    const before = await readSpsSourceArtifactInventory(db);
    await f.reader.withSnapshot(async scope => {
      const responses = [
        await f.host("post", sourceUrl).send({ displayName: "Must not be created" }),
        await f.host("patch", `${sourceUrl}/${f.source.id}`).send({ sharePath: "\\\\other.example\\Share" }),
        await f.host("delete", `${sourceUrl}/${f.source.id}`),
        await f.host("put", `${sourceUrl}/${f.source.id}/nodes/${f.node.id}`).send(envelope),
        await f.host("delete", `${sourceUrl}/${f.source.id}/nodes/${f.node.id}`),
        await f.host("put", shareUrl).send({ sharePath: "\\\\other.example\\Project" }),
        await f.host("put", `${shareUrl}/nodes/${f.node.id}`).send(envelope),
        await f.host("delete", `${shareUrl}/nodes/${f.node.id}`),
        await f.host("post", `/api/sps-nodes/${f.node.id}/approve`),
        await f.host("post", `/api/sps-nodes/${f.node.id}/revoke`),
        await f.host("post", `/api/sps-nodes/${f.node.id}/disconnect`),
        await f.host("post", `/api/companies/${f.workspace.id}/sps-members/${f.member.id}/revoke`),
        await f.host("delete", `/api/projects/${f.project.id}`),
        await f.host("delete", `/api/companies/${f.workspace.id}`),
      ];
      for (const response of responses) {
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.details).toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
      }
      expect(f.workspaceMutation).not.toHaveBeenCalled();
      expect((await f.host("get", sourceUrl)).status).toBe(200);
      expect((await request(f.app).patch(`${sourceUrl}/${f.source.id}`).send({ displayName: "Untrusted" })).status).toBe(403);
      await scope.assertCurrent();
    });
    expect(await readSpsSourceArtifactInventory(db)).toEqual(before);
    expect((await f.host("patch", `${sourceUrl}/${f.source.id}`).send({ displayName: "After release" })).status).toBe(200);
    await f.maintenance.withMaintenance(async () => {});
  });

  it("fences service-level project deletion before SQL and preserves Source/grants until release", async () => {
    const f = await fixture();
    const service = projectService(db, { artifactMaintenance: f.maintenance });
    await f.reader.withSnapshot(async scope => {
      await expect(service.remove(f.project.id)).rejects.toMatchObject({ status: 409 });
      await scope.assertCurrent();
    });
    expect(await service.remove(f.project.id)).toMatchObject({ id: f.project.id });
    const inventory = await readSpsSourceArtifactInventory(db);
    expect(inventory.sources.some(row => row.id === f.share.id)).toBe(false);
    expect(inventory.grants.some(row => row.sourceId === f.share.id)).toBe(false);
    expect(inventory.sources.some(row => row.id === f.source.id)).toBe(true);
  });

  it("fences service-level Workspace cascade before its transaction, then performs the existing delete", async () => {
    const f = await fixture();
    const service = companyService(db, { artifactMaintenance: f.maintenance });
    await f.reader.withSnapshot(async scope => {
      await expect(service.remove(f.workspace.id)).rejects.toMatchObject({ status: 409 });
      await scope.assertCurrent();
    });
    expect(await service.remove(f.workspace.id)).toMatchObject({ id: f.workspace.id });
    const inventory = await readSpsSourceArtifactInventory(db);
    expect(inventory.sources.some(row => row.workspaceId === f.workspace.id)).toBe(false);
    expect(inventory.grants.some(row => row.workspaceId === f.workspace.id)).toBe(false);
  });

  it.each([false, true])("keeps maintenance out until the actual cascade transaction commits or rolls back (rollback=%s)", async rollback => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const enteredTransaction = new Promise<void>(resolve => { entered = resolve; });
    const maySettle = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error("Controlled transaction rollback");
    const controlled = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return async (action: Parameters<Db["transaction"]>[0]) => db.transaction(async tx => {
          const result = await action(tx);
          entered();
          await maySettle;
          if (rollback) throw failure;
          return result;
        });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const removing = companyService(controlled, { artifactMaintenance: f.maintenance }).remove(f.workspace.id);
    void removing.catch(() => {});
    try {
      await Promise.race([enteredTransaction, removing.then(() => { throw new Error("Transaction settled without the held fixture."); })]);
      await expect(f.reader.withSnapshot(async () => expect.fail("A pending SQL transaction cannot grant cleanup observation.")))
        .rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    } finally { release(); }
    if (rollback) await expect(removing).rejects.toBe(failure);
    else expect(await removing).toMatchObject({ id: f.workspace.id });
    await f.maintenance.withMaintenance(async () => {});
    const inventory = await readSpsSourceArtifactInventory(db);
    expect(inventory.sources.some(row => row.workspaceId === f.workspace.id)).toBe(rollback);
    expect(inventory.grants.some(row => row.workspaceId === f.workspace.id)).toBe(rollback);
  });
});
