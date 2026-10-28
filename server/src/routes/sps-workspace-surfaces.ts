import { Router } from "express";
import { z } from "zod";
import type { Db } from "../compat/paperclip/db.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertSpsCoreHostAuthority,
  hasSpsCoreHostAuthority,
  logActivity,
  accessService,
  type PluginWorkerManager,
  type WorkerInvocationAuthority,
} from "../compat/paperclip/control-plane.js";
import type { SpsWorkspacePluginWorkers } from "../services/sps-workspace-plugin-workers.js";
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
  workspaceWorkers?: Pick<SpsWorkspacePluginWorkers, "call">,
) {
  const router = Router();
  const surfaces = spsWorkspaceSurfaceService(db);
  const access = accessService(db);

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
      if (!workerManager && !workspaceWorkers) {
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
      const params = {
        key: resolved.declaration.action,
        params: {
          companyId,
          inboxItemId: resolved.item.id,
          externalId: resolved.item.externalId,
          opaqueReference: resolved.item.opaqueReference,
        },
        actorContext: {
          type: "user" as const,
          userId: req.actor.userId ?? null,
          agentId: null,
          runId: req.actor.runId ?? null,
          companyId,
        },
        renderEnvironment: null,
      };
      let data: unknown;
      if (resolved.plugin.manifestJson.entrypoints.workspaceWorker) {
        if (!workspaceWorkers) {
          res.status(501).json({ error: "Workspace Plugin Inbox actions are unavailable" });
          return;
        }
        const actorJson = JSON.stringify({ type: req.actor.type, userId: req.actor.userId ?? null,
          runId: req.actor.runId ?? null, companyId });
        const authority: WorkerInvocationAuthority = {
          boundWorkspaceId: companyId,
          assertCurrent: async () => {
            assertBoard(req);
            assertCompanyAccess(req, companyId);
            if (boardUserId(req) !== userId || JSON.stringify({ type: req.actor.type, userId: req.actor.userId ?? null,
              runId: req.actor.runId ?? null, companyId }) !== actorJson) {
              throw new Error("Plugin Inbox actor authority changed.");
            }
            if (!hasSpsCoreHostAuthority(req)) {
              const membership = await access.getMembership(companyId, "user", userId);
              if (!membership || membership.status !== "active") {
                throw new Error("Plugin Inbox company membership is no longer active.");
              }
            }
            const current = await surfaces.resolveInboxAction({ companyId, userId, itemId, actionId });
            if (current.plugin.id !== resolved.plugin.id || current.item.id !== resolved.item.id
              || current.declaration.action !== resolved.declaration.action
              || !current.plugin.manifestJson.entrypoints.workspaceWorker) {
              throw new Error("Plugin Inbox action authority changed.");
            }
          },
        };
        data = await workspaceWorkers.call(companyId, resolved.plugin.id, "performAction", params, 30_000, authority);
      } else {
        if (!workerManager) {
          res.status(501).json({ error: "Plugin Inbox actions are unavailable" });
          return;
        }
        data = await workerManager.call(resolved.plugin.id, "performAction", params);
      }
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
