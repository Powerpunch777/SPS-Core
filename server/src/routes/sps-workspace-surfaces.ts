import { Router } from "express";
import { z } from "zod";
import type { Db } from "../compat/paperclip/db.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertSpsCoreHostAuthority,
  logActivity,
  type PluginWorkerManager,
} from "../compat/paperclip/control-plane.js";
import { spsWorkspaceSurfaceService } from "../services/sps-workspace-surfaces.js";
import { validate } from "../middleware/validate.js";

const shellSelectionSchema = z.object({
  pluginId: z.string().uuid().nullable(),
  shellId: z.string().min(1).max(100).nullable().optional(),
});

const dashboardLayoutSchema = z.object({
  items: z.array(z.object({
    pluginId: z.string().uuid(),
    widgetId: z.string().min(1).max(100),
    size: z.enum(["small", "medium", "large", "full"]),
    position: z.number().int(),
    collapsed: z.boolean().optional(),
  })).max(200),
});

const inboxStateSchema = z.object({
  read: z.boolean().optional(),
  archived: z.boolean().optional(),
}).refine((value) => value.read !== undefined || value.archived !== undefined, {
  message: "At least one Inbox state field is required",
});

function boardUserId(req: Parameters<typeof assertBoard>[0]): string {
  assertBoard(req);
  return req.actor.userId?.trim() || "local-host";
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0]! : value;
}

export function spsWorkspaceSurfaceRoutes(
  db: Db,
  workerManager?: PluginWorkerManager,
) {
  const router = Router();
  const surfaces = spsWorkspaceSurfaceService(db);

  router.get("/companies/:companyId/workspace-shell/providers", async (req, res) => {
    const companyId = routeParam(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await surfaces.listShellProviders(companyId));
  });

  router.get("/companies/:companyId/workspace-shell", async (req, res) => {
    const companyId = routeParam(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await surfaces.getShell(companyId));
  });

  router.put(
    "/companies/:companyId/workspace-shell",
    validate(shellSelectionSchema),
    async (req, res) => {
      const companyId = routeParam(req.params.companyId);
      assertSpsCoreHostAuthority(req);
      assertCompanyAccess(req, companyId);
      const state = await surfaces.selectShell({
        companyId,
        userId: boardUserId(req),
        pluginId: req.body.pluginId,
        shellId: req.body.shellId,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-host",
        action: "sps.workspace_shell.selected",
        entityType: "company",
        entityId: companyId,
        details: {
          pluginId: req.body.pluginId,
          shellId: req.body.shellId ?? null,
          mode: state.mode,
        },
      });
      res.json(state);
    },
  );

  router.get("/companies/:companyId/workspace-dashboard", async (req, res) => {
    const companyId = routeParam(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json({
      widgets: await surfaces.listDashboard(companyId, boardUserId(req)),
    });
  });

  router.put(
    "/companies/:companyId/workspace-dashboard/layout",
    validate(dashboardLayoutSchema),
    async (req, res) => {
      const companyId = routeParam(req.params.companyId);
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const widgets = await surfaces.saveDashboardLayout({
        companyId,
        userId: boardUserId(req),
        items: req.body.items,
      });
      res.json({ widgets });
    },
  );

  router.get("/companies/:companyId/workspace-inbox", async (req, res) => {
    const companyId = routeParam(req.params.companyId);
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json({
      items: await surfaces.listInbox({
        companyId,
        userId: boardUserId(req),
        includeArchived: req.query.archived === "true",
      }),
    });
  });

  router.patch(
    "/companies/:companyId/workspace-inbox/:itemId",
    validate(inboxStateSchema),
    async (req, res) => {
      const companyId = routeParam(req.params.companyId);
      const itemId = routeParam(req.params.itemId);
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const state = await surfaces.setInboxUserState({
        companyId,
        userId: boardUserId(req),
        itemId,
        read: req.body.read,
        archived: req.body.archived,
      });
      res.json(state);
    },
  );

  router.post(
    "/companies/:companyId/workspace-inbox/:itemId/actions/:actionId",
    async (req, res) => {
      const companyId = routeParam(req.params.companyId);
      const itemId = routeParam(req.params.itemId);
      const actionId = routeParam(req.params.actionId);
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!workerManager) {
        res.status(501).json({ error: "Plugin Inbox actions are unavailable" });
        return;
      }
      const userId = boardUserId(req);
      const resolved = await surfaces.resolveInboxAction({
        companyId,
        userId,
        itemId,
        actionId,
      });
      const data = await workerManager.call(resolved.plugin.id, "performAction", {
        key: resolved.declaration.action,
        params: {
          companyId,
          inboxItemId: resolved.item.id,
          externalId: resolved.item.externalId,
          opaqueReference: resolved.item.opaqueReference,
        },
        actorContext: {
          type: "user",
          userId: req.actor.userId ?? null,
          agentId: null,
          runId: req.actor.runId ?? null,
          companyId,
        },
        renderEnvironment: null,
      });
      await surfaces.setInboxUserState({
        companyId,
        userId,
        itemId,
        read: true,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "local-host",
        action: "sps.workspace_inbox.action_dispatched",
        entityType: "plugin_inbox_item",
        entityId: itemId,
        details: {
          pluginId: resolved.plugin.id,
          actionId,
          workerAction: resolved.declaration.action,
        },
      });
      res.json({ data });
    },
  );

  return router;
}
