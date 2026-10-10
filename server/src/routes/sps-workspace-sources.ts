import { Router, type Request } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import {
  spsNodes,
  spsWorkspaceSourceNodeGrants,
  spsWorkspaceSources,
} from "../compat/paperclip/db.js";
import {
  createSpsWorkspaceSourceSchema,
  grantSpsWorkspaceSourceNodeSchema,
  updateSpsWorkspaceSourceSchema,
} from "../compat/paperclip/shared.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { hasTrustedDesktopOwnerBootstrap } from "../middleware/desktop-local-access.js";
import {
  assertBoard,
  assertCompanyAccess,
  logActivity,
} from "../compat/paperclip/control-plane.js";
import { validate } from "../middleware/validate.js";

function actorUserId(req: Request) {
  return req.actor.type === "board" ? req.actor.userId ?? "local-board" : "local-board";
}

function publicSource(source: typeof spsWorkspaceSources.$inferSelect) {
  return {
    id: source.id,
    displayName: source.displayName,
    status: source.status,
    routeStatus: source.sharePath ? "ready" : "unavailable",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

/**
 * Workspace Sources are physical Host resources, not a project or task
 * feature. Only the local Desktop main process that owns the Host may change
 * their route or Node grants; the Host's selected local folder never reaches
 * this API.
 */
export function spsWorkspaceSourceRoutes(db: Db) {
  const router = Router();

  function assertHost(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (!hasTrustedDesktopOwnerBootstrap(req)) {
      throw forbidden("Only the local SPS Host can manage Workspace Sources");
    }
  }

  async function getSource(companyId: string, sourceId: string) {
    const source = await db
      .select()
      .from(spsWorkspaceSources)
      .where(and(eq(spsWorkspaceSources.companyId, companyId), eq(spsWorkspaceSources.id, sourceId)))
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("SPS Workspace Source not found");
    return source;
  }

  router.get("/companies/:companyId/sps-workspace-sources", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertHost(req, companyId);
    const [sources, nodes, grants] = await Promise.all([
      db
        .select()
        .from(spsWorkspaceSources)
        .where(eq(spsWorkspaceSources.companyId, companyId))
        .orderBy(spsWorkspaceSources.createdAt),
      db
        .select({
          id: spsNodes.id,
          displayName: spsNodes.displayName,
          status: spsNodes.status,
          keyVerifiedAt: spsNodes.keyVerifiedAt,
          transportPublicKey: spsNodes.transportPublicKey,
        })
        .from(spsNodes)
        .where(eq(spsNodes.companyId, companyId))
        .orderBy(desc(spsNodes.createdAt)),
      db
        .select({
          sourceId: spsWorkspaceSourceNodeGrants.sourceId,
          nodeId: spsWorkspaceSourceNodeGrants.nodeId,
          revokedAt: spsWorkspaceSourceNodeGrants.revokedAt,
          updatedAt: spsWorkspaceSourceNodeGrants.updatedAt,
        })
        .from(spsWorkspaceSourceNodeGrants)
        .where(eq(spsWorkspaceSourceNodeGrants.companyId, companyId)),
    ]);
    const grantsBySource = new Map<string, typeof grants>();
    for (const grant of grants) {
      const current = grantsBySource.get(grant.sourceId) ?? [];
      current.push(grant);
      grantsBySource.set(grant.sourceId, current);
    }
    res.json({
      sources: sources.map((source) => ({
        ...publicSource(source),
        nodeGrants: (grantsBySource.get(source.id) ?? []).map((grant) => ({
          nodeId: grant.nodeId,
          status: grant.revokedAt ? "revoked" : "granted",
          updatedAt: grant.updatedAt,
        })),
      })),
      nodes,
    });
  });

  router.post(
    "/companies/:companyId/sps-workspace-sources",
    validate(createSpsWorkspaceSourceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertHost(req, companyId);
      const source = await db
        .insert(spsWorkspaceSources)
        .values({
          companyId,
          displayName: req.body.displayName,
          createdByUserId: actorUserId(req),
        })
        .returning()
        .then((rows) => rows[0]!);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "sps_workspace_source.created",
        entityType: "sps_workspace_source",
        entityId: source.id,
        details: { displayName: source.displayName },
      });
      res.status(201).json(publicSource(source));
    },
  );

  router.patch(
    "/companies/:companyId/sps-workspace-sources/:sourceId",
    validate(updateSpsWorkspaceSourceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertHost(req, companyId);
      const source = await getSource(companyId, req.params.sourceId as string);
      if (req.body.sharePath !== undefined && req.body.sharePath !== null && !req.body.sharePath.startsWith("\\\\")) {
        throw badRequest("SPS Workspace Source routes must be managed UNC share paths");
      }
      const updated = await db
        .update(spsWorkspaceSources)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(spsWorkspaceSources.id, source.id))
        .returning()
        .then((rows) => rows[0]!);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "sps_workspace_source.updated",
        entityType: "sps_workspace_source",
        entityId: source.id,
        details: { changed: Object.keys(req.body).sort() },
      });
      res.json(publicSource(updated));
    },
  );

  router.delete("/companies/:companyId/sps-workspace-sources/:sourceId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertHost(req, companyId);
    const source = await getSource(companyId, req.params.sourceId as string);
    await db.delete(spsWorkspaceSources).where(eq(spsWorkspaceSources.id, source.id));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "sps_workspace_source.deleted",
      entityType: "sps_workspace_source",
      entityId: source.id,
      details: { displayName: source.displayName },
    });
    res.status(204).end();
  });

  router.put(
    "/companies/:companyId/sps-workspace-sources/:sourceId/nodes/:nodeId",
    validate(grantSpsWorkspaceSourceNodeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertHost(req, companyId);
      const [source, node] = await Promise.all([
        getSource(companyId, req.params.sourceId as string),
        db
          .select()
          .from(spsNodes)
          .where(and(eq(spsNodes.companyId, companyId), eq(spsNodes.id, req.params.nodeId as string)))
          .then((rows) => rows[0] ?? null),
      ]);
      if (!node) throw notFound("SPS Node not found");
      if (source.status !== "active") throw badRequest("Resume this Workspace Source before granting Node access");
      if (!source.sharePath) throw badRequest("Configure a Host-managed transport route before granting this Workspace Source to a Node");
      if (node.status !== "active" || !node.keyVerifiedAt || !node.transportPublicKey) {
        throw badRequest("This SPS Node must be active and publish a transport public key before it can receive Workspace Source access");
      }
      const now = new Date();
      const existing = await db
        .select()
        .from(spsWorkspaceSourceNodeGrants)
        .where(and(
          eq(spsWorkspaceSourceNodeGrants.sourceId, source.id),
          eq(spsWorkspaceSourceNodeGrants.nodeId, node.id),
        ))
        .then((rows) => rows[0] ?? null);
      const grant = existing
        ? await db
          .update(spsWorkspaceSourceNodeGrants)
          .set({
            credentialAlgorithm: req.body.credentialAlgorithm,
            credentialEnvelope: req.body.credentialEnvelope,
            grantedByUserId: actorUserId(req),
            revokedAt: null,
            updatedAt: now,
          })
          .where(eq(spsWorkspaceSourceNodeGrants.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
        : await db
          .insert(spsWorkspaceSourceNodeGrants)
          .values({
            companyId,
            sourceId: source.id,
            nodeId: node.id,
            credentialAlgorithm: req.body.credentialAlgorithm,
            credentialEnvelope: req.body.credentialEnvelope,
            grantedByUserId: actorUserId(req),
          })
          .returning()
          .then((rows) => rows[0]!);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId(req),
        action: "sps_workspace_source.node_granted",
        entityType: "sps_node",
        entityId: node.id,
        details: { sourceId: source.id },
      });
      res.json({ id: grant.id, nodeId: grant.nodeId, grantedAt: grant.updatedAt });
    },
  );

  router.delete("/companies/:companyId/sps-workspace-sources/:sourceId/nodes/:nodeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertHost(req, companyId);
    const source = await getSource(companyId, req.params.sourceId as string);
    const now = new Date();
    const revoked = await db
      .update(spsWorkspaceSourceNodeGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(spsWorkspaceSourceNodeGrants.sourceId, source.id),
        eq(spsWorkspaceSourceNodeGrants.nodeId, req.params.nodeId as string),
        isNull(spsWorkspaceSourceNodeGrants.revokedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!revoked) throw notFound("SPS Workspace Source Node grant not found");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req),
      action: "sps_workspace_source.node_revoked",
      entityType: "sps_node",
      entityId: revoked.nodeId,
      details: { sourceId: source.id },
    });
    res.status(204).end();
  });

  return router;
}
