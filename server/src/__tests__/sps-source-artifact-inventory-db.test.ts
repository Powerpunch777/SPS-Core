import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  projects,
  spsHostProjectShareNodeGrants,
  spsHostProjectShares,
  spsNodes,
  spsWorkspaceSourceNodeGrants,
  spsWorkspaceSources,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { readSpsSourceArtifactInventory } from "../services/sps-source-artifact-inventory.js";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { createSpsPluginArtifactReferenceReader } from "../services/sps-plugin-artifact-references.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const FAKE_ENVELOPE = "FAKE_ENCRYPTED_CREDENTIAL_ENVELOPE_DO_NOT_EXPOSE";
const FAKE_PROJECT_ENVELOPE = "FAKE_REVOKED_PROJECT_GRANT_ENVELOPE_DO_NOT_EXPOSE";
const PLAIN_SECRET = "PLAINTEXT_SHARE_SECRET_MUST_NEVER_APPEAR";
const FIRST_ROUTE = "\\\\host-one.example.ts.net\\WorkspaceShare";
const SECOND_ROUTE = "\\\\node-b.example.ts.net\\SecondShare";
const PROJECT_ROUTE = "\\\\host-one.example.ts.net\\ProjectShare";

function uniqueIssuePrefix() {
  return `SI${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

describeEmbeddedPostgres("SPS Source artifact inventory database reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let firstWorkspaceId: string;
  let secondWorkspaceId: string;
  let sourceId: string;
  let projectShareId: string;
  let projectGrantId: string;
  let firstWorkspaceNodeId: string;
  let nodeId: string;
  let grantId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-source-artifact-inventory-");
    db = createDb(database.connectionString);

    const firstWorkspace = await db.insert(companies).values({
      name: `Inventory Workspace One ${randomUUID()}`,
      issuePrefix: uniqueIssuePrefix(),
    }).returning().then((rows) => rows[0]!);
    const secondWorkspace = await db.insert(companies).values({
      name: `Inventory Workspace Two ${randomUUID()}`,
      issuePrefix: uniqueIssuePrefix(),
    }).returning().then((rows) => rows[0]!);
    firstWorkspaceId = firstWorkspace.id;
    secondWorkspaceId = secondWorkspace.id;

    await db.insert(spsWorkspaceSources).values({
      companyId: firstWorkspaceId,
      displayName: `PRIVATE_DISPLAY_NAME_ALPHA_${PLAIN_SECRET}`,
      sharePath: null,
      status: "disabled",
      createdByUserId: "inventory-test",
    });
    const routedSource = await db.insert(spsWorkspaceSources).values({
      companyId: secondWorkspaceId,
      displayName: "PRIVATE_DISPLAY_NAME_BETA",
      sharePath: FIRST_ROUTE,
      status: "active",
      createdByUserId: "inventory-test",
    }).returning().then((rows) => rows[0]!);
    sourceId = routedSource.id;

    const project = await db.insert(projects).values({
      companyId: firstWorkspaceId,
      name: `Inventory project ${randomUUID()}`,
    }).returning().then((rows) => rows[0]!);
    const projectShare = await db.insert(spsHostProjectShares).values({
      companyId: firstWorkspaceId,
      projectId: project.id,
      sharePath: PROJECT_ROUTE,
      status: "active",
      createdByUserId: "inventory-test",
    }).returning().then((rows) => rows[0]!);
    projectShareId = projectShare.id;

    const firstWorkspaceNode = await db.insert(spsNodes).values({
      companyId: firstWorkspaceId,
      ownerUserId: "inventory-test-project-node-owner",
      displayName: "PRIVATE_PROJECT_NODE_DISPLAY_NAME",
      publicKey: `inventory-project-node-${randomUUID()}`,
      platform: "windows",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    firstWorkspaceNodeId = firstWorkspaceNode.id;
    const projectGrantRevokedAt = new Date("2025-01-02T03:04:05.000Z");
    const projectGrant = await db.insert(spsHostProjectShareNodeGrants).values({
      companyId: firstWorkspaceId,
      shareId: projectShareId,
      nodeId: firstWorkspaceNodeId,
      credentialEnvelope: FAKE_PROJECT_ENVELOPE,
      grantedByUserId: "inventory-test",
      revokedAt: projectGrantRevokedAt,
      updatedAt: projectGrantRevokedAt,
    }).returning().then((rows) => rows[0]!);
    projectGrantId = projectGrant.id;

    const node = await db.insert(spsNodes).values({
      companyId: secondWorkspaceId,
      ownerUserId: "inventory-test-node-owner",
      displayName: "PRIVATE_NODE_DISPLAY_NAME",
      publicKey: `inventory-test-${randomUUID()}`,
      transportPublicKey: "inventory-test-transport-key",
      platform: "windows",
      status: "active",
      keyVerifiedAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    nodeId = node.id;

    const grant = await db.insert(spsWorkspaceSourceNodeGrants).values({
      companyId: secondWorkspaceId,
      sourceId,
      nodeId,
      credentialEnvelope: FAKE_ENVELOPE,
      grantedByUserId: "inventory-test",
    }).returning().then((rows) => rows[0]!);
    grantId = grant.id;
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("reads every Workspace and project source without exposing private values or changing rows", async () => {
    const before = {
      sources: await db.select().from(spsWorkspaceSources),
      workspaceGrants: await db.select().from(spsWorkspaceSourceNodeGrants),
      projectShares: await db.select().from(spsHostProjectShares),
      projectGrants: await db.select().from(spsHostProjectShareNodeGrants),
    };
    const inventory = await readSpsSourceArtifactInventory(db);
    const after = {
      sources: await db.select().from(spsWorkspaceSources),
      workspaceGrants: await db.select().from(spsWorkspaceSourceNodeGrants),
      projectShares: await db.select().from(spsHostProjectShares),
      projectGrants: await db.select().from(spsHostProjectShareNodeGrants),
    };

    expect(after).toEqual(before);
    expect(inventory.sources).toHaveLength(3);
    expect(inventory.grants).toHaveLength(2);
    expect(inventory.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workspace", workspaceId: firstWorkspaceId, status: "disabled", routeFingerprint: null }),
      expect.objectContaining({ kind: "workspace", id: sourceId, workspaceId: secondWorkspaceId, status: "active" }),
      expect.objectContaining({ kind: "project", workspaceId: firstWorkspaceId, status: "active" }),
    ]));
    expect(inventory.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: grantId, kind: "workspace", workspaceId: secondWorkspaceId, sourceId, nodeId, revokedAt: null }),
      expect.objectContaining({
        id: projectGrantId,
        kind: "project",
        workspaceId: firstWorkspaceId,
        sourceId: projectShareId,
        nodeId: firstWorkspaceNodeId,
        revokedAt: "2025-01-02T03:04:05.000Z",
      }),
    ]));

    const serialized = JSON.stringify(inventory);
    for (const privateValue of [
      FIRST_ROUTE,
      SECOND_ROUTE,
      PROJECT_ROUTE,
      FAKE_ENVELOPE,
      FAKE_PROJECT_ENVELOPE,
      PLAIN_SECRET,
      "PRIVATE_DISPLAY_NAME_ALPHA",
      "PRIVATE_DISPLAY_NAME_BETA",
      "PRIVATE_NODE_DISPLAY_NAME",
      "PRIVATE_PROJECT_NODE_DISPLAY_NAME",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(inventory.sources.find((source) => source.id === sourceId)?.routeFingerprint)
      .not.toBe(FIRST_ROUTE);
  });

  it("keeps IDs and ordering stable and fingerprints route, status, and revocation changes", async () => {
    const firstRead = await readSpsSourceArtifactInventory(db);
    const repeatedRead = await readSpsSourceArtifactInventory(db);
    expect(repeatedRead).toEqual(firstRead);
    expect(firstRead.sources.map(({ kind, id }) => `${kind}:${id}`)).toEqual(
      [...firstRead.sources.map(({ kind, id }) => `${kind}:${id}`)].sort(),
    );
    expect(firstRead.grants.map(({ kind, id }) => `${kind}:${id}`)).toEqual(
      [...firstRead.grants.map(({ kind, id }) => `${kind}:${id}`)].sort(),
    );

    const routeRevision = new Date(Date.now() + 1_000);
    await db.update(spsWorkspaceSources).set({ sharePath: SECOND_ROUTE, updatedAt: routeRevision })
      .where(eq(spsWorkspaceSources.id, sourceId));
    const routeChanged = await readSpsSourceArtifactInventory(db);
    expect(routeChanged.fingerprint).not.toBe(firstRead.fingerprint);
    expect(routeChanged.sources.find((source) => source.id === sourceId)?.id).toBe(sourceId);

    await db.update(spsWorkspaceSources).set({ status: "paused", updatedAt: new Date(Date.now() + 2_000) })
      .where(eq(spsWorkspaceSources.id, sourceId));
    const statusChanged = await readSpsSourceArtifactInventory(db);
    expect(statusChanged.fingerprint).not.toBe(routeChanged.fingerprint);

    const revokedAt = new Date(Date.now() + 3_000);
    await db.update(spsWorkspaceSourceNodeGrants).set({ revokedAt, updatedAt: revokedAt })
      .where(eq(spsWorkspaceSourceNodeGrants.id, grantId));
    const grantRevoked = await readSpsSourceArtifactInventory(db);
    expect(grantRevoked.fingerprint).not.toBe(statusChanged.fingerprint);
    expect(grantRevoked.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: grantId,
        kind: "workspace",
        workspaceId: secondWorkspaceId,
        sourceId,
        nodeId,
        revokedAt: revokedAt.toISOString(),
      }),
      expect.objectContaining({
        id: projectGrantId,
        kind: "project",
        workspaceId: firstWorkspaceId,
        sourceId: projectShareId,
        nodeId: firstWorkspaceNodeId,
        revokedAt: "2025-01-02T03:04:05.000Z",
      }),
    ]));
  });

  it("fails closed when a grant Workspace differs from its Source Workspace", async () => {
    const otherWorkspaceNode = await db.insert(spsNodes).values({
      companyId: firstWorkspaceId,
      ownerUserId: "inventory-test-other-owner",
      displayName: "Cross-workspace test Node",
      publicKey: `inventory-cross-workspace-${randomUUID()}`,
      platform: "windows",
      status: "active",
    }).returning().then((rows) => rows[0]!);

    try {
      await db.insert(spsWorkspaceSourceNodeGrants).values({
        companyId: firstWorkspaceId,
        sourceId,
        nodeId: otherWorkspaceNode.id,
        credentialEnvelope: FAKE_ENVELOPE,
        grantedByUserId: "inventory-test",
      });

      await expect(readSpsSourceArtifactInventory(db)).rejects.toMatchObject({
        code: "SPS_SOURCE_ARTIFACT_INVENTORY_UNAVAILABLE",
      });
    } finally {
      await db.delete(spsWorkspaceSourceNodeGrants)
        .where(eq(spsWorkspaceSourceNodeGrants.nodeId, otherWorkspaceNode.id));
      await db.delete(spsNodes).where(eq(spsNodes.id, otherWorkspaceNode.id));
    }
  });

  it("revalidates Source fingerprints in the reference snapshot and releases maintenance afterward", async () => {
    const [sourceBefore] = await db.select().from(spsWorkspaceSources)
      .where(eq(spsWorkspaceSources.id, sourceId));
    if (!sourceBefore) throw new Error("Inventory Source fixture is missing.");
    const pluginRoot = await mkdtemp(join(tmpdir(), "sps-plugin-artifact-inventory-"));
    const maintenance = createSpsPluginArtifactMaintenance();
    const reader = createSpsPluginArtifactReferenceReader({
      localPluginDir: pluginRoot,
      maintenance,
      readers: {
        listPlugins: async () => [],
        listPending: async () => [],
        listRetainedReviews: async () => [],
        readWorkers: () => [],
        readPreparations: () => [],
        readRegistryStages: async () => [],
        readSourceFingerprint: () => readSpsSourceArtifactInventory(db).then((inventory) => inventory.fingerprint),
      },
    });

    try {
      await expect(reader.withSnapshot(async (scope) => {
        await db.update(spsWorkspaceSources).set({
          status: sourceBefore.status === "paused" ? "active" : "paused",
          updatedAt: new Date(Date.now() + 10_000),
        }).where(eq(spsWorkspaceSources.id, sourceId));
        await expect(scope.assertCurrent()).rejects.toMatchObject({
          code: "SPS_PLUGIN_ARTIFACT_REFERENCES_UNAVAILABLE",
        });
      })).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_REFERENCES_UNAVAILABLE" });

      await expect(maintenance.withActivity(async () => "activity allowed")).resolves.toBe("activity allowed");
    } finally {
      try {
        await db.update(spsWorkspaceSources).set({
          sharePath: sourceBefore.sharePath,
          status: sourceBefore.status,
          updatedAt: sourceBefore.updatedAt,
        }).where(eq(spsWorkspaceSources.id, sourceId));
      } finally {
        await rm(pluginRoot, { recursive: true, force: true });
      }
    }
  });
});
