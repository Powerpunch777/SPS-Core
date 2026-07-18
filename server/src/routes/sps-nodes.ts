import { createHash, createPublicKey, verify } from "node:crypto";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  spsAgentNodeBindings,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodeAgentGrants,
  spsNodeHeartbeats,
  spsNodes,
} from "@paperclipai/db";
import {
  bindSpsAgentNodeSchema,
  createSpsNodeSchema,
  spsNodeHeartbeatMessage,
  spsNodeHeartbeatSchema,
  spsNodeCommandCompleteSchema,
  spsNodeCommandEventSchema,
  spsNodeSignedRequestMessage,
  spsNodeSignedRequestSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function actorUserId(req: Request) {
  return req.actor.type === "board" ? req.actor.userId ?? "local-board" : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function signedRequestPayload(body: Record<string, unknown>) {
  const { timestamp: _timestamp, nonce: _nonce, signature: _signature, ...payload } = body;
  return payload;
}

export function spsNodeRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  async function getNode(nodeId: string) {
    const node = await db
      .select()
      .from(spsNodes)
      .where(eq(spsNodes.id, nodeId))
      .then((rows) => rows[0] ?? null);
    if (!node) throw notFound("SPS Node not found");
    return node;
  }

  async function getAgent(agentId: string) {
    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function assertSpsNodeAdmin(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;

    const userId = req.actor.userId;
    if (!userId) throw unauthorized("Board authentication required");
    const membership = await access.getMembership(companyId, "user", userId);
    if (
      membership?.status === "active"
      && (membership.membershipRole === "owner" || membership.membershipRole === "admin")
    ) {
      return;
    }
    throw forbidden("Only company owners and admins can manage SPS Nodes");
  }

  function assertSpsNodeOwner(req: Request, node: typeof spsNodes.$inferSelect) {
    assertBoard(req);
    assertCompanyAccess(req, node.companyId);
    if (req.actor.source !== "local_implicit" && req.actor.userId !== node.ownerUserId) {
      throw forbidden("Only the computer owner may use this SPS Node");
    }
  }

  async function assertSignedNodeRequest(req: Request, node: typeof spsNodes.$inferSelect) {
    assertSpsNodeOwner(req, node);

    const signed = spsNodeSignedRequestSchema.parse(req.body ?? {});
    const signedAt = new Date(signed.timestamp);
    const now = new Date();
    const maxClockSkewMs = 5 * 60 * 1000;
    if (Math.abs(now.getTime() - signedAt.getTime()) > maxClockSkewMs) {
      throw badRequest("SPS Node request timestamp is outside the allowed clock-skew window");
    }

    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey(node.publicKey);
    } catch {
      throw badRequest("SPS Node public key is not a supported public key format");
    }
    const bodySha256 = createHash("sha256")
      .update(canonicalJson(signedRequestPayload(req.body ?? {})), "utf8")
      .digest("hex");
    const message = spsNodeSignedRequestMessage({
      nodeId: node.id,
      method: req.method,
      path: req.path,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
      bodySha256,
    });
    if (!verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signed.signature, "base64"))) {
      throw forbidden("SPS Node request signature is invalid");
    }

    const nonceHash = createHash("sha256").update(`request:${node.id}:${signed.nonce}`).digest("hex");
    const nonceExpiry = new Date(signedAt.getTime() + maxClockSkewMs + 60_000);
    await db.delete(spsNodeHeartbeats).where(lt(spsNodeHeartbeats.expiresAt, now));
    const replay = await db
      .select({ id: spsNodeHeartbeats.id })
      .from(spsNodeHeartbeats)
      .where(eq(spsNodeHeartbeats.nonceHash, nonceHash))
      .then((rows) => rows[0] ?? null);
    if (replay) throw forbidden("SPS Node request nonce has already been used");
    await db.insert(spsNodeHeartbeats).values({
      nodeId: node.id,
      nonceHash,
      signedAt,
      expiresAt: nonceExpiry,
    });
  }

  async function logNodeMutation(
    req: Request,
    input: {
      companyId: string;
      action: string;
      nodeId: string;
      details?: Record<string, unknown>;
    },
  ) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: actorUserId(req) ?? "unknown-user",
      action: input.action,
      entityType: "sps_node",
      entityId: input.nodeId,
      details: input.details ?? {},
    });
  }

  async function commandHasCurrentAuthority(
    node: typeof spsNodes.$inferSelect,
    command: typeof spsNodeCommands.$inferSelect,
  ) {
    if (node.status !== "active" || !node.keyVerifiedAt) return false;
    const [grant, binding] = await Promise.all([
      db
        .select({ id: spsNodeAgentGrants.id })
        .from(spsNodeAgentGrants)
        .where(and(
          eq(spsNodeAgentGrants.companyId, node.companyId),
          eq(spsNodeAgentGrants.nodeId, node.id),
          eq(spsNodeAgentGrants.agentId, command.agentId),
          isNull(spsNodeAgentGrants.revokedAt),
        ))
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: spsAgentNodeBindings.id })
        .from(spsAgentNodeBindings)
        .where(and(
          eq(spsAgentNodeBindings.companyId, node.companyId),
          eq(spsAgentNodeBindings.nodeId, node.id),
          eq(spsAgentNodeBindings.agentId, command.agentId),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(grant && binding);
  }

  async function failActiveNodeCommands(input: {
    nodeId: string;
    agentId?: string;
    reason: string;
  }) {
    const now = new Date();
    const predicates = [
      eq(spsNodeCommands.nodeId, input.nodeId),
      inArray(spsNodeCommands.status, ["queued", "claimed", "running"]),
    ];
    if (input.agentId) predicates.push(eq(spsNodeCommands.agentId, input.agentId));
    await db
      .update(spsNodeCommands)
      .set({ status: "failed", error: input.reason, finishedAt: now, updatedAt: now })
      .where(and(...predicates));
  }

  router.get("/companies/:companyId/sps-nodes", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpsNodeAdmin(req, companyId);

    const [nodes, grants, bindings, companyAgents] = await Promise.all([
      db
        .select()
        .from(spsNodes)
        .where(eq(spsNodes.companyId, companyId))
        .orderBy(desc(spsNodes.createdAt)),
      db
        .select()
        .from(spsNodeAgentGrants)
        .where(and(eq(spsNodeAgentGrants.companyId, companyId), isNull(spsNodeAgentGrants.revokedAt))),
      db
        .select()
        .from(spsAgentNodeBindings)
        .where(eq(spsAgentNodeBindings.companyId, companyId)),
      db
        .select({ id: agents.id, name: agents.name, title: agents.title })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
    ]);

    const agentById = new Map(companyAgents.map((agent) => [agent.id, agent]));
    res.json(nodes.map((node) => ({
      ...node,
      agentGrants: grants
        .filter((grant) => grant.nodeId === node.id)
        .map((grant) => ({
          ...grant,
          agent: agentById.get(grant.agentId) ?? null,
        })),
      primaryAgentBindings: bindings
        .filter((binding) => binding.nodeId === node.id)
        .map((binding) => ({
          ...binding,
          agent: agentById.get(binding.agentId) ?? null,
        })),
    })));
  });

  router.post(
    "/companies/:companyId/sps-nodes",
    validate(createSpsNodeSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const userId = actorUserId(req);
      if (!userId) throw unauthorized("Board authentication required");

      const now = new Date();
      const existing = await db
        .select()
        .from(spsNodes)
        .where(and(eq(spsNodes.companyId, companyId), eq(spsNodes.publicKey, req.body.publicKey)))
        .then((rows) => rows[0] ?? null);

      if (existing && existing.ownerUserId !== userId) {
        throw forbidden("This SPS Node belongs to another company member");
      }

      const node = existing
        ? await db
          .update(spsNodes)
          .set({
            displayName: req.body.displayName,
            platform: req.body.platform,
            appVersion: req.body.appVersion ?? null,
            capabilities: req.body.capabilities,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(spsNodes.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
        : await db
          .insert(spsNodes)
          .values({
            companyId,
            ownerUserId: userId,
            displayName: req.body.displayName,
            publicKey: req.body.publicKey,
            platform: req.body.platform,
            appVersion: req.body.appVersion ?? null,
            capabilities: req.body.capabilities,
            lastSeenAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);

      await logNodeMutation(req, {
        companyId,
        action: existing ? "sps_node.updated" : "sps_node.registered",
        nodeId: node.id,
        details: { status: node.status, capabilityKinds: node.capabilities.map((item) => item.kind) },
      });
      res.status(existing ? 200 : 201).json(node);
    },
  );

  router.post(
    "/sps-nodes/:nodeId/heartbeat",
    validate(spsNodeHeartbeatSchema),
    async (req, res) => {
      const node = await getNode(req.params.nodeId as string);
      assertSpsNodeOwner(req, node);
      if (node.status === "revoked") throw forbidden("This SPS Node has been revoked");

      const signedAt = new Date(req.body.timestamp);
      const now = new Date();
      const maxClockSkewMs = 5 * 60 * 1000;
      if (Math.abs(now.getTime() - signedAt.getTime()) > maxClockSkewMs) {
        throw badRequest("SPS Node heartbeat timestamp is outside the allowed clock-skew window");
      }

      let key: ReturnType<typeof createPublicKey>;
      try {
        key = createPublicKey(node.publicKey);
      } catch {
        throw badRequest("SPS Node public key is not a supported public key format");
      }
      if (key.asymmetricKeyType !== "ed25519") {
        throw badRequest("SPS Node public key must use Ed25519");
      }

      const message = spsNodeHeartbeatMessage({
        nodeId: node.id,
        timestamp: req.body.timestamp,
        nonce: req.body.nonce,
      });
      const signatureValid = verify(
        null,
        Buffer.from(message, "utf8"),
        key,
        Buffer.from(req.body.signature, "base64"),
      );
      if (!signatureValid) throw forbidden("SPS Node heartbeat signature is invalid");

      const nonceHash = createHash("sha256").update(req.body.nonce).digest("hex");
      const nonceExpiry = new Date(signedAt.getTime() + maxClockSkewMs + 60_000);
      await db.delete(spsNodeHeartbeats).where(lt(spsNodeHeartbeats.expiresAt, now));
      const replay = await db
        .select({ id: spsNodeHeartbeats.id })
        .from(spsNodeHeartbeats)
        .where(eq(spsNodeHeartbeats.nonceHash, nonceHash))
        .then((rows) => rows[0] ?? null);
      if (replay) throw forbidden("SPS Node heartbeat nonce has already been used");

      await db.insert(spsNodeHeartbeats).values({
        nodeId: node.id,
        nonceHash,
        signedAt,
        expiresAt: nonceExpiry,
      });
      const verifiedAt = node.keyVerifiedAt ?? now;
      const updated = await db
        .update(spsNodes)
        .set({ keyVerifiedAt: verifiedAt, lastSeenAt: now, updatedAt: now })
        .where(eq(spsNodes.id, node.id))
        .returning()
        .then((rows) => rows[0]!);
      res.json(updated);
    },
  );

  router.post("/sps-nodes/:nodeId/approve", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    if (!node.keyVerifiedAt) {
      throw forbidden("SPS Node must complete a signed heartbeat before approval");
    }
    const now = new Date();
    const updated = await db
      .update(spsNodes)
      .set({
        status: "active",
        approvedAt: now,
        approvedByUserId: actorUserId(req),
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(spsNodes.id, node.id))
      .returning()
      .then((rows) => rows[0]!);
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.approved",
      nodeId: node.id,
    });
    res.json(updated);
  });

  router.post("/sps-nodes/:nodeId/revoke", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    const now = new Date();
    const updated = await db
      .update(spsNodes)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(eq(spsNodes.id, node.id))
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(spsNodeAgentGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(spsNodeAgentGrants.nodeId, node.id), isNull(spsNodeAgentGrants.revokedAt)));
    await db.delete(spsAgentNodeBindings).where(eq(spsAgentNodeBindings.nodeId, node.id));
    await failActiveNodeCommands({
      nodeId: node.id,
      reason: "SPS Node access was revoked while this command was running.",
    });
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.revoked",
      nodeId: node.id,
    });
    res.json(updated);
  });

  router.put("/sps-nodes/:nodeId/agent-grants/:agentId", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    if (node.status !== "active") {
      throw forbidden("Approve this SPS Node before granting it to an Agent");
    }
    const agent = await getAgent(req.params.agentId as string);
    if (agent.companyId !== node.companyId) throw forbidden("Agent belongs to another company");

    const now = new Date();
    const grant = await db
      .insert(spsNodeAgentGrants)
      .values({
        companyId: node.companyId,
        nodeId: node.id,
        agentId: agent.id,
        grantedByUserId: actorUserId(req) ?? "local-board",
      })
      .onConflictDoUpdate({
        target: [spsNodeAgentGrants.nodeId, spsNodeAgentGrants.agentId],
        set: {
          companyId: node.companyId,
          grantedByUserId: actorUserId(req) ?? "local-board",
          revokedAt: null,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0]!);
    const existingBinding = await db
      .select({ id: spsAgentNodeBindings.id })
      .from(spsAgentNodeBindings)
      .where(and(
        eq(spsAgentNodeBindings.companyId, agent.companyId),
        eq(spsAgentNodeBindings.agentId, agent.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existingBinding) {
      const automaticBinding = await db
        .insert(spsAgentNodeBindings)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          nodeId: node.id,
          assignedByUserId: actorUserId(req) ?? "local-board",
        })
        .onConflictDoNothing()
        .returning();
      if (automaticBinding.length > 0) {
        await logNodeMutation(req, {
          companyId: node.companyId,
          action: "sps_node.agent_primary_bound",
          nodeId: node.id,
          details: { agentId: agent.id, automatic: true },
        });
      }
    }
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.agent_granted",
      nodeId: node.id,
      details: { agentId: agent.id },
    });
    res.json(grant);
  });

  router.delete("/sps-nodes/:nodeId/agent-grants/:agentId", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    const agent = await getAgent(req.params.agentId as string);
    if (agent.companyId !== node.companyId) throw forbidden("Agent belongs to another company");

    const now = new Date();
    await db
      .update(spsNodeAgentGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(spsNodeAgentGrants.nodeId, node.id),
        eq(spsNodeAgentGrants.agentId, agent.id),
        isNull(spsNodeAgentGrants.revokedAt),
      ));
    await db.delete(spsAgentNodeBindings).where(and(
      eq(spsAgentNodeBindings.nodeId, node.id),
      eq(spsAgentNodeBindings.agentId, agent.id),
    ));
    await failActiveNodeCommands({
      nodeId: node.id,
      agentId: agent.id,
      reason: "This Agent no longer has access to the SPS Node running this command.",
    });
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.agent_revoked",
      nodeId: node.id,
      details: { agentId: agent.id },
    });
    res.status(204).end();
  });

  router.put(
    "/agents/:agentId/sps-node-binding",
    validate(bindSpsAgentNodeSchema),
    async (req, res) => {
      const agent = await getAgent(req.params.agentId as string);
      await assertSpsNodeAdmin(req, agent.companyId);
      const node = await getNode(req.body.nodeId);
      if (node.companyId !== agent.companyId) throw forbidden("SPS Node belongs to another company");
      if (node.status !== "active") throw forbidden("SPS Node is not active");

      const grant = await db
        .select()
        .from(spsNodeAgentGrants)
        .where(and(
          eq(spsNodeAgentGrants.nodeId, node.id),
          eq(spsNodeAgentGrants.agentId, agent.id),
          isNull(spsNodeAgentGrants.revokedAt),
        ))
        .then((rows) => rows[0] ?? null);
      if (!grant) throw forbidden("Grant this SPS Node to the Agent before making it primary");

      const previousBinding = await db
        .select()
        .from(spsAgentNodeBindings)
        .where(and(
          eq(spsAgentNodeBindings.companyId, agent.companyId),
          eq(spsAgentNodeBindings.agentId, agent.id),
        ))
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      const binding = await db
        .insert(spsAgentNodeBindings)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          nodeId: node.id,
          assignedByUserId: actorUserId(req) ?? "local-board",
        })
        .onConflictDoUpdate({
          target: spsAgentNodeBindings.agentId,
          set: {
            companyId: agent.companyId,
            nodeId: node.id,
            assignedByUserId: actorUserId(req) ?? "local-board",
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0]!);
      if (previousBinding && previousBinding.nodeId !== node.id) {
        await failActiveNodeCommands({
          nodeId: previousBinding.nodeId,
          agentId: agent.id,
          reason: "This Agent was reassigned to another SPS Node while this command was running.",
        });
      }
      await logNodeMutation(req, {
        companyId: agent.companyId,
        action: "sps_node.agent_primary_bound",
        nodeId: node.id,
        details: { agentId: agent.id },
      });
      res.json(binding);
    },
  );

  router.delete("/agents/:agentId/sps-node-binding", async (req, res) => {
    const agent = await getAgent(req.params.agentId as string);
    await assertSpsNodeAdmin(req, agent.companyId);
    const binding = await db
      .select()
      .from(spsAgentNodeBindings)
      .where(and(
        eq(spsAgentNodeBindings.companyId, agent.companyId),
        eq(spsAgentNodeBindings.agentId, agent.id),
      ))
      .then((rows) => rows[0] ?? null);
    await db
      .delete(spsAgentNodeBindings)
      .where(and(
        eq(spsAgentNodeBindings.companyId, agent.companyId),
        eq(spsAgentNodeBindings.agentId, agent.id),
      ));
    if (binding) {
      await failActiveNodeCommands({
        nodeId: binding.nodeId,
        agentId: agent.id,
        reason: "The SPS Node binding was removed while this command was running.",
      });
    }
    res.status(204).end();
  });

  router.post("/sps-nodes/:nodeId/commands/claim-next", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    if (node.status !== "active" || !node.keyVerifiedAt) {
      throw forbidden("This SPS Node is not approved for command execution");
    }
    await assertSignedNodeRequest(req, node);

    // A Node can be restarted mid-command. Re-queue only an old, unreported
    // claim; active CLI process ownership remains local to the Desktop Node.
    const now = new Date();
    const staleBefore = new Date(now.getTime() - 10 * 60 * 1000);
    await db
      .update(spsNodeCommands)
      .set({ status: "queued", claimedAt: null, startedAt: null, updatedAt: now })
      .where(and(
        eq(spsNodeCommands.nodeId, node.id),
        eq(spsNodeCommands.status, "claimed"),
        lt(spsNodeCommands.updatedAt, staleBefore),
      ));

    // Re-check authority at claim time. A queued command must not survive an
    // owner revoking the Node grant or changing the Agent's primary Node.
    // This is intentionally checked by the Node-facing boundary as well as
    // when the Hub originally creates the command.
    while (true) {
      const candidate = await db
        .select()
        .from(spsNodeCommands)
        .where(and(eq(spsNodeCommands.nodeId, node.id), eq(spsNodeCommands.status, "queued")))
        .orderBy(spsNodeCommands.createdAt)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!candidate) return res.status(204).end();

      if (!await commandHasCurrentAuthority(node, candidate)) {
        await db
          .update(spsNodeCommands)
          .set({
            status: "failed",
            error: "SPS Node access was revoked or reassigned before this command was claimed.",
            finishedAt: now,
            updatedAt: now,
          })
          .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")));
        continue;
      }

      const claimed = await db
        .update(spsNodeCommands)
        .set({ status: "claimed", claimedAt: now, startedAt: now, updatedAt: now })
        .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (claimed) return res.json(claimed);
    }
  });

  router.post("/sps-nodes/:nodeId/commands/:commandId/lease", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSignedNodeRequest(req, node);
    const command = await db
      .select()
      .from(spsNodeCommands)
      .where(and(eq(spsNodeCommands.id, req.params.commandId as string), eq(spsNodeCommands.nodeId, node.id)))
      .then((rows) => rows[0] ?? null);
    if (!command) throw notFound("SPS Node command not found");
    if (command.status !== "claimed" && command.status !== "running") {
      return res.json({ active: false, status: command.status, error: command.error ?? null });
    }
    if (!await commandHasCurrentAuthority(node, command)) {
      await failActiveNodeCommands({
        nodeId: node.id,
        agentId: command.agentId,
        reason: "SPS Node access was revoked or reassigned while this command was running.",
      });
      return res.json({
        active: false,
        status: "failed",
        error: "SPS Node access was revoked or reassigned while this command was running.",
      });
    }
    res.json({ active: true, status: command.status, error: null });
  });

  router.post("/sps-nodes/:nodeId/commands/:commandId/events", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSignedNodeRequest(req, node);
    const event = spsNodeCommandEventSchema.parse(req.body ?? {});
    const command = await db
      .select()
      .from(spsNodeCommands)
      .where(and(eq(spsNodeCommands.id, req.params.commandId as string), eq(spsNodeCommands.nodeId, node.id)))
      .then((rows) => rows[0] ?? null);
    if (!command) throw notFound("SPS Node command not found");
    if (command.status !== "claimed" && command.status !== "running") {
      throw forbidden("SPS Node command is not accepting output");
    }
    if (!await commandHasCurrentAuthority(node, command)) {
      await failActiveNodeCommands({
        nodeId: node.id,
        agentId: command.agentId,
        reason: "SPS Node access was revoked or reassigned while this command was running.",
      });
      throw forbidden("SPS Node command access was revoked while it was running");
    }
    if (event.sequence !== command.lastEventSeq + 1) {
      throw badRequest("SPS Node command output sequence is out of order");
    }
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(spsNodeCommandEvents).values({
        commandId: command.id,
        sequence: event.sequence,
        stream: event.stream,
        body: event.body,
      });
      await tx
        .update(spsNodeCommands)
        .set({ status: "running", lastEventSeq: event.sequence, updatedAt: now })
        .where(eq(spsNodeCommands.id, command.id));
    });
    res.status(204).end();
  });

  router.post("/sps-nodes/:nodeId/commands/:commandId/complete", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSignedNodeRequest(req, node);
    const completion = spsNodeCommandCompleteSchema.parse(req.body ?? {});
    const command = await db
      .select()
      .from(spsNodeCommands)
      .where(and(eq(spsNodeCommands.id, req.params.commandId as string), eq(spsNodeCommands.nodeId, node.id)))
      .then((rows) => rows[0] ?? null);
    if (!command) throw notFound("SPS Node command not found");
    if (command.status === "succeeded" || command.status === "failed") return res.json(command);
    if (command.status !== "claimed" && command.status !== "running") {
      throw forbidden("SPS Node command is not active");
    }
    if (!await commandHasCurrentAuthority(node, command)) {
      await failActiveNodeCommands({
        nodeId: node.id,
        agentId: command.agentId,
        reason: "SPS Node access was revoked or reassigned while this command was running.",
      });
      const failed = await db
        .select()
        .from(spsNodeCommands)
        .where(eq(spsNodeCommands.id, command.id))
        .then((rows) => rows[0]!);
      return res.json(failed);
    }
    const updated = await db
      .update(spsNodeCommands)
      .set({
        status: completion.status,
        exitCode: completion.exitCode,
        signal: completion.signal ?? null,
        timedOut: completion.timedOut ? 1 : 0,
        error: completion.error ?? null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(spsNodeCommands.id, command.id))
      .returning()
      .then((rows) => rows[0]!);
    res.json(updated);
  });

  return router;
}
