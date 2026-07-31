import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { getServerAdapter } from "../adapters/index.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createSpsMarketplaceAssistantService } from "../services/sps-marketplace-assistant.js";
import { coreMarketplaceToolBridge } from "../services/sps-marketplace-tool-bridge.js";
import { getMarketplacePlugin, searchMarketplacePlugins } from "../services/sps-marketplace.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const createAssistantSessionSchema = z.object({
  agentId: z.string().uuid(),
}).strict();

const sendAssistantMessageSchema = z.object({
  content: z.string().trim().min(1).max(16_000),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
}).strict();

const executeAssistantToolSchema = z.object({ input: z.unknown() }).strict();

function queryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function queryLimit(value: unknown): number | undefined {
  const raw = queryString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function boardUserId(req: Request): string {
  assertBoard(req);
  const userId = req.actor.userId?.trim();
  if (!userId) throw unauthorized("SPS sign-in is required for Marketplace Assistant");
  return userId;
}

function adapterSupportsMarketplaceAssistant(agent: typeof agents.$inferSelect): boolean {
  const adapter = getServerAdapter(agent.adapterType);
  return Boolean(
    adapter.supportsLocalAgentJwt &&
    adapter.supportsExternalTools &&
    adapter.acp?.supportsMcpStdio,
  );
}

export function spsMarketplaceRoutes(db: Db, pluginWorkerManager?: PluginWorkerManager) {
  const router = Router();
  const access = accessService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager });
  const assistant = createSpsMarketplaceAssistantService(db);

  async function getCompanyAgent(companyId: string, agentId: string) {
    const agent = await db.select().from(agents).where(and(
      eq(agents.id, agentId),
      eq(agents.companyId, companyId),
    )).then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function assertCanInvokeAgent(req: Request, companyId: string, agentId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "agent:invoke",
      resource: { type: "agent", companyId, agentId },
      scope: { targetAgentId: agentId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);
  }

  router.get("/companies/:companyId/marketplace/plugins", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await searchMarketplacePlugins({
      q: queryString(req.query.q),
      category: queryString(req.query.category),
      capability: queryString(req.query.capability),
      limit: queryLimit(req.query.limit),
    }));
  });

  router.get("/companies/:companyId/marketplace/plugins/:pluginId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await getMarketplacePlugin(req.params.pluginId as string));
  });

  router.get("/companies/:companyId/marketplace/assistant/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    boardUserId(req);
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const visible = await Promise.all(rows.map(async (agent) => ({
      agent,
      allowed: adapterSupportsMarketplaceAssistant(agent) &&
        isAgentStatusInvokable(agent.status) &&
        (await access.decide({
          actor: req.actor,
          action: "agent:invoke",
          resource: { type: "agent", companyId, agentId: agent.id },
          scope: { targetAgentId: agent.id },
        })).allowed,
    })));
    res.json({
      agents: visible.filter((item) => item.allowed).map(({ agent }) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
        icon: agent.icon,
        adapterType: agent.adapterType,
        status: agent.status,
      })),
    });
  });

  router.post(
    "/companies/:companyId/marketplace/assistant/sessions",
    validate(createAssistantSessionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = boardUserId(req);
      const agent = await getCompanyAgent(companyId, req.body.agentId);
      await assertCanInvokeAgent(req, companyId, agent.id);
      if (!isAgentStatusInvokable(agent.status)) {
        throw conflict(`Agent ${agent.name} is not available for work`);
      }
      if (!adapterSupportsMarketplaceAssistant(agent)) {
        throw badRequest(`Agent ${agent.name} does not support Marketplace Assistant tools`);
      }
      const session = await assistant.getOrCreateSession({
        companyId,
        userId,
        agentId: agent.id,
        adapterType: agent.adapterType,
      });
      res.status(201).json({ session });
    },
  );

  router.get("/companies/:companyId/marketplace/assistant/sessions/:sessionId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = boardUserId(req);
    const session = await assistant.getSession({
      sessionId: req.params.sessionId as string,
      companyId,
      userId,
    });
    if (!session) throw notFound("Marketplace Assistant session not found");
    res.json(await assistant.listMessages({
      sessionId: session.id,
      limit: queryLimit(req.query.limit),
      after: queryString(req.query.after),
    }));
  });

  router.post(
    "/companies/:companyId/marketplace/assistant/sessions/:sessionId/messages",
    validate(sendAssistantMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = boardUserId(req);
      const session = await assistant.getSession({
        sessionId: req.params.sessionId as string,
        companyId,
        userId,
      });
      if (!session) throw notFound("Marketplace Assistant session not found");
      if (session.status !== "active") throw conflict("Marketplace Assistant session is closed");
      const agent = await getCompanyAgent(companyId, session.agentId);
      await assertCanInvokeAgent(req, companyId, agent.id);
      if (!isAgentStatusInvokable(agent.status)) throw conflict(`Agent ${agent.name} is not available for work`);
      if (!adapterSupportsMarketplaceAssistant(agent)) throw badRequest(`Agent ${agent.name} no longer supports Marketplace Assistant tools`);
      if (session.adapterType !== agent.adapterType) {
        throw conflict("The selected Agent configuration changed. Start a new Marketplace Assistant session.");
      }

      const requestId = req.body.idempotencyKey ?? randomUUID();
      const userMessage = await assistant.appendMessage({
        sessionId: session.id,
        runId: requestId,
        idempotencyKey: `user:${requestId}`,
        role: "user",
        content: req.body.content,
        metadata: { requestId },
      });
      const run = await heartbeat.wakeup(agent.id, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "marketplace_assistant_message",
        idempotencyKey: `marketplace-assistant:${session.id}:${requestId}`,
        requestedByActorType: "user",
        requestedByActorId: userId,
        contextSnapshot: {
          taskKey: session.taskKey,
          skipIssueComment: true,
          spsMarketplaceAssistant: {
            sessionId: session.id,
            userId,
            message: req.body.content,
          },
        },
      });
      if (!run) {
        await assistant.appendMessage({
          sessionId: session.id,
          runId: requestId,
          idempotencyKey: `system:${requestId}`,
          role: "system",
          content: "The selected Agent could not be queued. Check its status and try again.",
          metadata: { outcome: "not_queued" },
        });
        throw conflict("The selected Agent could not be queued");
      }
      res.status(202).json({ message: userMessage, run });
    },
  );

  router.post("/companies/:companyId/marketplace/assistant/sessions/:sessionId/close", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = boardUserId(req);
    const session = await assistant.getSession({
      sessionId: req.params.sessionId as string,
      companyId,
      userId,
    });
    if (!session) throw notFound("Marketplace Assistant session not found");
    res.json({ session: await assistant.closeSession(session.id) ?? session });
  });

  router.post(
    "/companies/:companyId/marketplace/assistant/tools/:toolName",
    validate(executeAssistantToolSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (req.actor.type !== "agent" || req.actor.keyScope?.kind !== "marketplace_assistant") {
        throw forbidden("Marketplace Assistant scoped Agent token required");
      }
      assertCompanyAccess(req, companyId);
      const userId = req.actor.onBehalfOfUserId?.trim();
      const runId = req.actor.runId?.trim();
      const agentId = req.actor.agentId?.trim();
      if (!userId || !runId || !agentId) throw forbidden("Marketplace Assistant execution identity is incomplete");
      const session = await assistant.getSession({
        sessionId: req.actor.keyScope.sessionId,
        companyId,
        userId,
      });
      if (!session || session.agentId !== agentId) throw forbidden("Marketplace Assistant session scope mismatch");
      const output = await coreMarketplaceToolBridge.execute(
        req.params.toolName as string,
        req.body.input,
        { companyId, runId, agentId, userId },
      );
      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        action: "marketplace.assistant_tool_executed",
        entityType: "agent_task_session",
        entityId: session.id,
        details: { toolName: req.params.toolName },
      });
      res.json(output);
    },
  );

  return router;
}
