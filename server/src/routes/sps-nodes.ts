import { Router, type Request } from "express";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import {
  agents,
  heartbeatRuns,
  projects,
  spsAgentNodeBindings,
  spsHostProjectShareNodeGrants,
  spsHostProjectShares,
  spsWorkspaceSourceNodeGrants,
  spsWorkspaceSources,
  spsPluginExecutionGrants,
  spsPluginNodeRunEvents,
  spsPluginNodeRuns,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodeAgentGrants,
  spsNodeAgentRunnerGrants,
  spsNodeHeartbeats,
  spsNodeRunnerProfiles,
  spsNodes,
} from "../compat/paperclip/db.js";
import {
  bindSpsAgentNodeSchema,
  createSpsNodeSchema,
  spsNodeCapabilityForAdapter,
  spsNodeExecutableRuntimeKindSchema,
  spsNodeSupportsAdapter,
  grantSpsHostProjectShareNodeSchema,
  isAgentStatusAssignableToWork,
  upsertSpsHostProjectShareSchema,
  type SpsNodeRunnerProfile,
} from "../compat/paperclip/shared.js";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { hasTrustedDesktopOwnerBootstrap } from "../middleware/desktop-local-access.js";
import {
  accessService,
  assertBoard,
  assertCompanyAccess,
  hasSpsCoreHostAuthority,
  logActivity,
} from "../compat/paperclip/control-plane.js";
import { isSpsCoreBaselineModeEnabled } from "../ui-branding.js";
import { createSpsNodeOperations, type SpsNodeOperationContext } from "../services/sps-node-operations.js";

function actorUserId(req: Request) {
  return req.actor.type === "board" ? req.actor.userId ?? "local-board" : null;
}

export function spsNodeRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const nodeOperations = createSpsNodeOperations(db);

  function operationContext(req: Request): SpsNodeOperationContext {
    return {
      userId: actorUserId(req) ?? "",
      authorizeWorkspace(companyId) { assertBoard(req); assertCompanyAccess(req, companyId); },
      authorizeNode(node, transactionDb) { return assertSpsNodeOwner(req, node, transactionDb as Db | undefined); },
      async logMutation(input) { await logNodeMutation(req, input); },
      signatureMethod: req.method,
      signaturePath: req.path,
    };
  }

  function sendOperationResult(res: import("express").Response, result: { status: number; data: unknown }) {
    if (result.status === 204) return res.status(204).end();
    return res.status(result.status).json(result.data);
  }

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

  function assertNodeSupportsAgentAdapter(
    node: typeof spsNodes.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const capabilityKind = spsNodeCapabilityForAdapter(agent.adapterType);
    if (!capabilityKind) {
      throw badRequest(`Agent \"${agent.name}\" uses adapter \"${agent.adapterType}\", which cannot run through an SPS Desktop Node.`);
    }
    if (!spsNodeSupportsAdapter(node.capabilities, agent.adapterType)) {
      throw badRequest(`SPS Node \"${node.displayName}\" does not advertise the ${capabilityKind} runtime required by Agent \"${agent.name}\".`);
    }
  }

  function assertAgentCanReceiveNodeAccess(agent: typeof agents.$inferSelect) {
    if (!isAgentStatusAssignableToWork(agent.status)) {
      throw badRequest(`Agent \"${agent.name}\" is ${agent.status} and cannot receive SPS Node execution access.`);
    }
  }

  async function assertSpsNodeAdmin(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    if (isSpsCoreBaselineModeEnabled()) {
      if (hasSpsCoreHostAuthority(req)) return;
      throw forbidden("Only the SPS Host can manage SPS Nodes");
    }

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

  function assertSpsHostProjectShareOwner(req: Request) {
    // A project source folder is a physical Host capability, not a normal
    // project setting. Only the Desktop main process on the loopback Owner
    // Host carries both per-launch proofs; a Member's Workspace session and a
    // browser cannot create or alter this access route.
    if (!hasTrustedDesktopOwnerBootstrap(req)) {
      throw forbidden("Only the local SPS Owner Host can configure project source access");
    }
  }

  async function getProjectShareProject(projectId: string) {
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    return project;
  }

  async function assertSpsNodeOwner(req: Request, node: typeof spsNodes.$inferSelect, transactionDb?: Db) {
    assertBoard(req);
    if (req.actor.source !== "local_implicit" && req.actor.userId !== node.ownerUserId) {
      throw forbidden("Only the computer owner may use this SPS Node");
    }
    // A technical Member removal is broader than an ordinary Node revocation:
    // the Desktop must stop retaining this team's connection rather than trying
    // to re-enroll its Node. Emit a narrow machine-readable signal after
    // confirming the caller owns this exact Node.
    if (req.actor.source !== "local_implicit" && req.actor.userId) {
      const membership = await (transactionDb ? accessService(transactionDb) : access).getMembership(node.companyId, "user", req.actor.userId);
      if (membership?.status === "archived") {
        throw forbidden("This SPS technical Member has been removed", {
          code: "sps_technical_member_removed",
          remediation: "Ask the SPS Host for a new Desktop invitation.",
        });
      }
    }
    assertCompanyAccess(req, node.companyId);
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

  function fallbackRunnerProfiles(capabilities: typeof spsNodes.$inferSelect["capabilities"]): SpsNodeRunnerProfile[] {
    return capabilities.map((capability) => ({
      runnerKey: `${capability.kind}:default`,
      kind: capability.kind,
      label: capability.label,
      version: capability.version ?? null,
      ...(capability.models?.length ? { models: capability.models } : {}),
    }));
  }

  async function reconcileNodeRunnerProfiles(
    node: typeof spsNodes.$inferSelect,
    runners: ReadonlyArray<SpsNodeRunnerProfile>,
  ) {
    const now = new Date();
    const seenRunnerKeys = new Set<string>();
    const profiles = [];
    for (const runner of runners) {
      if (seenRunnerKeys.has(runner.runnerKey)) continue;
      seenRunnerKeys.add(runner.runnerKey);
      const availability = runner.availability;
      const observedAt = availability?.observedAt ? new Date(availability.observedAt) : now;
      const retryAfter = availability?.retryAfter ? new Date(availability.retryAfter) : null;
      const profile = await db
        .insert(spsNodeRunnerProfiles)
        .values({
          companyId: node.companyId,
          nodeId: node.id,
          runnerKey: runner.runnerKey,
          kind: runner.kind,
          label: runner.label,
          version: runner.version ?? null,
          models: runner.models ?? [],
          profileLabel: runner.profileLabel ?? null,
          credentialStatus: runner.credentialStatus ?? "unknown",
          availabilityStatus: availability?.status ?? "unknown",
          availabilityDetail: availability?.detail ?? null,
          availabilitySource: availability?.source ?? "node_probe",
          availabilityConfidence: availability?.confidence ?? null,
          availabilityObservedAt: observedAt,
          retryAfter,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [spsNodeRunnerProfiles.nodeId, spsNodeRunnerProfiles.runnerKey],
          set: {
            kind: runner.kind,
            label: runner.label,
            version: runner.version ?? null,
            models: runner.models ?? [],
            profileLabel: runner.profileLabel ?? null,
            credentialStatus: runner.credentialStatus ?? "unknown",
            availabilityStatus: availability?.status ?? "unknown",
            availabilityDetail: availability?.detail ?? null,
            availabilitySource: availability?.source ?? "node_probe",
            availabilityConfidence: availability?.confidence ?? null,
            availabilityObservedAt: observedAt,
            retryAfter,
            updatedAt: now,
          },
        })
        .returning()
        .then((rows) => rows[0]!);
      profiles.push(profile);
    }
    return profiles;
  }

  async function grantCompatibleRunners(input: {
    node: typeof spsNodes.$inferSelect;
    agent: typeof agents.$inferSelect;
    grantedByUserId: string;
    restoreRevoked?: boolean;
  }) {
    const requiredKind = spsNodeCapabilityForAdapter(input.agent.adapterType);
    if (!requiredKind) return [];
    const now = new Date();
    const compatibleProfiles = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(and(
        eq(spsNodeRunnerProfiles.companyId, input.node.companyId),
        eq(spsNodeRunnerProfiles.nodeId, input.node.id),
        eq(spsNodeRunnerProfiles.kind, requiredKind),
      ));
    return await Promise.all(compatibleProfiles.map(async (runner) => {
      const existing = await db
        .select()
        .from(spsNodeAgentRunnerGrants)
        .where(and(
          eq(spsNodeAgentRunnerGrants.nodeId, input.node.id),
          eq(spsNodeAgentRunnerGrants.runnerProfileId, runner.id),
          eq(spsNodeAgentRunnerGrants.agentId, input.agent.id),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing?.revokedAt && input.restoreRevoked === false) return existing;
      if (existing) {
        return await db
          .update(spsNodeAgentRunnerGrants)
          .set({
            companyId: input.node.companyId,
            grantedByUserId: input.grantedByUserId,
            revokedAt: null,
            updatedAt: now,
          })
          .where(eq(spsNodeAgentRunnerGrants.id, existing.id))
          .returning()
          .then((rows) => rows[0]!);
      }
      return await db
        .insert(spsNodeAgentRunnerGrants)
        .values({
          companyId: input.node.companyId,
          nodeId: input.node.id,
          runnerProfileId: runner.id,
          agentId: input.agent.id,
          grantedByUserId: input.grantedByUserId,
        })
        .returning()
        .then((rows) => rows[0]!);
    }));
  }

  async function syncExistingNodeAgentRunnerGrants(
    node: typeof spsNodes.$inferSelect,
    grantedByUserId: string,
  ) {
    const activeGrants = await db
      .select({ agent: agents })
      .from(spsNodeAgentGrants)
      .innerJoin(agents, eq(agents.id, spsNodeAgentGrants.agentId))
      .where(and(
        eq(spsNodeAgentGrants.companyId, node.companyId),
        eq(spsNodeAgentGrants.nodeId, node.id),
        isNull(spsNodeAgentGrants.revokedAt),
      ));
    return await Promise.all(activeGrants.map(async ({ agent }) => await grantCompatibleRunners({
      node,
      agent,
      grantedByUserId,
      restoreRevoked: false,
    })));
  }

  async function commandHasCurrentAuthority(
    node: typeof spsNodes.$inferSelect,
    command: typeof spsNodeCommands.$inferSelect,
  ) {
    if (node.status !== "active" || !node.keyVerifiedAt) return false;
    const [grant, binding, runnerGrants] = await Promise.all([
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
      command.runnerProfileId
        ? db
          .select({ runnerProfileId: spsNodeAgentRunnerGrants.runnerProfileId })
          .from(spsNodeAgentRunnerGrants)
          .where(and(
            eq(spsNodeAgentRunnerGrants.companyId, node.companyId),
            eq(spsNodeAgentRunnerGrants.nodeId, node.id),
            eq(spsNodeAgentRunnerGrants.agentId, command.agentId),
            isNull(spsNodeAgentRunnerGrants.revokedAt),
          ))
        : Promise.resolve([]),
    ]);
    if (!grant || !binding) return false;
    // Commands created before Runner Profiles were introduced remain valid.
    // Every command that names a profile must retain that exact grant.
    if (
      command.runnerProfileId
      && !runnerGrants.some((runnerGrant) => runnerGrant.runnerProfileId === command.runnerProfileId)
    ) {
      return false;
    }
    const workspaceAccess = command.workspaceAccess as Record<string, unknown> | null;
    if (workspaceAccess?.kind !== "sps_host_share") return true;
    const shareId = typeof workspaceAccess.shareId === "string" ? workspaceAccess.shareId : null;
    if (!shareId) return false;
    const sourceGrant = await db
      .select({ id: spsHostProjectShareNodeGrants.id })
      .from(spsHostProjectShareNodeGrants)
      .innerJoin(spsHostProjectShares, eq(spsHostProjectShares.id, spsHostProjectShareNodeGrants.shareId))
      .where(and(
        eq(spsHostProjectShareNodeGrants.shareId, shareId),
        eq(spsHostProjectShareNodeGrants.nodeId, node.id),
        eq(spsHostProjectShareNodeGrants.companyId, node.companyId),
        isNull(spsHostProjectShareNodeGrants.revokedAt),
        eq(spsHostProjectShares.companyId, node.companyId),
        eq(spsHostProjectShares.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    return Boolean(sourceGrant);
  }

  async function commandRunnerCanStart(command: typeof spsNodeCommands.$inferSelect) {
    if (!command.runnerProfileId) return true;
    const runner = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(eq(spsNodeRunnerProfiles.id, command.runnerProfileId))
      .then((rows) => rows[0] ?? null);
    return runner !== null
      && runner.credentialStatus !== "auth_required"
      && (runner.availabilityStatus === "available" || runner.availabilityStatus === "unknown");
  }

  async function pluginRunHasCurrentAuthority(
    node: typeof spsNodes.$inferSelect,
    run: typeof spsPluginNodeRuns.$inferSelect,
  ) {
    if (node.status !== "active" || !node.keyVerifiedAt) return false;
    const [grant, runner] = await Promise.all([
      db
        .select()
        .from(spsPluginExecutionGrants)
        .where(and(
          eq(spsPluginExecutionGrants.id, run.executionGrantId),
          eq(spsPluginExecutionGrants.companyId, node.companyId),
          eq(spsPluginExecutionGrants.pluginKey, run.pluginKey),
          eq(spsPluginExecutionGrants.subjectKey, run.subjectKey),
          eq(spsPluginExecutionGrants.nodeId, node.id),
          eq(spsPluginExecutionGrants.runnerProfileId, run.runnerProfileId),
          eq(spsPluginExecutionGrants.status, "active"),
          isNull(spsPluginExecutionGrants.revokedAt),
        ))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(spsNodeRunnerProfiles)
        .where(and(
          eq(spsNodeRunnerProfiles.id, run.runnerProfileId),
          eq(spsNodeRunnerProfiles.companyId, node.companyId),
          eq(spsNodeRunnerProfiles.nodeId, node.id),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    if (!grant || !runner || !spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind).success) return false;
    if ((grant.workspaceSourceId ?? null) !== (run.workspaceSourceId ?? null)) return false;
    if (!run.workspaceSourceId) return true;

    const [source, sourceGrant] = await Promise.all([
      db.select({ id: spsWorkspaceSources.id }).from(spsWorkspaceSources).where(and(
        eq(spsWorkspaceSources.id, run.workspaceSourceId), eq(spsWorkspaceSources.companyId, node.companyId),
        eq(spsWorkspaceSources.status, "active"))).then((rows) => rows[0] ?? null),
      db.select({ id: spsWorkspaceSourceNodeGrants.id }).from(spsWorkspaceSourceNodeGrants).where(and(
        eq(spsWorkspaceSourceNodeGrants.sourceId, run.workspaceSourceId), eq(spsWorkspaceSourceNodeGrants.companyId, node.companyId),
        eq(spsWorkspaceSourceNodeGrants.nodeId, node.id), isNull(spsWorkspaceSourceNodeGrants.revokedAt))).then((rows) => rows[0] ?? null),
    ]);
    // The physical Host resolves its own Source mapping locally. A Member
    // must also pass the encrypted route claim while preparing the command,
    // so the Hub never needs a Member-local filesystem path here.
    return Boolean(source && sourceGrant);
  }

  async function pluginRunRunnerCanStart(run: typeof spsPluginNodeRuns.$inferSelect) {
    const runner = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(eq(spsNodeRunnerProfiles.id, run.runnerProfileId))
      .then((rows) => rows[0] ?? null);
    return runner !== null
      && spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind).success
      && runner.credentialStatus !== "auth_required"
      && (runner.availabilityStatus === "available" || runner.availabilityStatus === "unknown");
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

  async function failActivePluginNodeRuns(input: {
    nodeId: string;
    pluginKey?: string;
    subjectKey?: string;
    reason: string;
  }) {
    const now = new Date();
    const predicates = [
      eq(spsPluginNodeRuns.nodeId, input.nodeId),
      inArray(spsPluginNodeRuns.status, ["queued", "claimed", "running"]),
    ];
    if (input.pluginKey) predicates.push(eq(spsPluginNodeRuns.pluginKey, input.pluginKey));
    if (input.subjectKey) predicates.push(eq(spsPluginNodeRuns.subjectKey, input.subjectKey));
    await db
      .update(spsPluginNodeRuns)
      .set({ status: "failed", error: input.reason, finishedAt: now, updatedAt: now })
      .where(and(...predicates));
  }

  async function revokeNodeExecutionAccess(
    req: Request,
    node: typeof spsNodes.$inferSelect,
    input: { action: string; reason: string },
  ) {
    const now = new Date();
    const updated = await db
      .update(spsNodes)
      .set({
        status: "revoked",
        revokedAt: now,
        // A revoked Node must re-enroll with a newly generated local key.
        // Otherwise the historical heartbeat proof could be reused to regain
        // execution access by calling approve again.
        keyVerifiedAt: null,
        approvedAt: null,
        approvedByUserId: null,
        updatedAt: now,
      })
      .where(eq(spsNodes.id, node.id))
      .returning()
      .then((rows) => rows[0]!);
    await db
      .update(spsNodeAgentGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(spsNodeAgentGrants.nodeId, node.id), isNull(spsNodeAgentGrants.revokedAt)));
    await db
      .update(spsNodeAgentRunnerGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(spsNodeAgentRunnerGrants.nodeId, node.id), isNull(spsNodeAgentRunnerGrants.revokedAt)));
    await db
      .update(spsHostProjectShareNodeGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(spsHostProjectShareNodeGrants.nodeId, node.id), isNull(spsHostProjectShareNodeGrants.revokedAt)));
    await db
      .update(spsWorkspaceSourceNodeGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(spsWorkspaceSourceNodeGrants.nodeId, node.id), isNull(spsWorkspaceSourceNodeGrants.revokedAt)));
    await db.delete(spsAgentNodeBindings).where(eq(spsAgentNodeBindings.nodeId, node.id));
    await failActiveNodeCommands({ nodeId: node.id, reason: input.reason });
    await failActivePluginNodeRuns({ nodeId: node.id, reason: input.reason });
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: input.action,
      nodeId: node.id,
    });
    return updated;
  }

  async function assertSpsCoreTechnicalMemberManagement(req: Request, companyId: string) {
    if (!isSpsCoreBaselineModeEnabled()) {
      throw notFound("SPS technical Member management is available only in the SPS Core baseline");
    }
    await assertSpsNodeAdmin(req, companyId);
  }

  router.get("/companies/:companyId/sps-members", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpsCoreTechnicalMemberManagement(req, companyId);
    const [memberships, nodes] = await Promise.all([
      access.listMembers(companyId),
      db
        .select({ ownerUserId: spsNodes.ownerUserId, status: spsNodes.status })
        .from(spsNodes)
        .where(eq(spsNodes.companyId, companyId)),
    ]);
    const nodesByUserId = new Map();
    for (const node of nodes) {
      const summary = nodesByUserId.get(node.ownerUserId) ?? { total: 0, active: 0 };
      summary.total += 1;
      if (node.status === "active") summary.active += 1;
      nodesByUserId.set(node.ownerUserId, summary);
    }
    res.json({
      members: memberships
        .filter((membership) => membership.principalType === "user")
        .map((membership) => ({
          id: membership.id,
          accountId: membership.principalId,
          isHost: membership.membershipRole === "owner",
          status: membership.status,
          joinedAt: membership.createdAt,
          archivedAt: membership.status === "archived" ? membership.updatedAt : null,
          nodeCount: nodesByUserId.get(membership.principalId)?.total ?? 0,
          activeNodeCount: nodesByUserId.get(membership.principalId)?.active ?? 0,
        })),
    });
  });

  router.post("/companies/:companyId/sps-members/:memberId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const memberId = req.params.memberId as string;
    await assertSpsCoreTechnicalMemberManagement(req, companyId);
    const member = await access.getMemberById(companyId, memberId);
    if (!member) throw notFound("SPS technical Member not found");
    if (member.principalType !== "user") throw badRequest("Only human technical Members can be removed");
    if (member.membershipRole === "owner") {
      throw forbidden("The SPS Host technical membership cannot be removed");
    }

    const ownedNodes = await db
      .select()
      .from(spsNodes)
      .where(and(eq(spsNodes.companyId, companyId), eq(spsNodes.ownerUserId, member.principalId)));
    const revokedNodes = [];
    for (const node of ownedNodes) {
      if (node.status === "revoked") continue;
      revokedNodes.push(await revokeNodeExecutionAccess(req, node, {
        action: "sps_technical_member.node_revoked",
        reason: "The technical SPS Member that owns this Node was removed.",
      }));
    }
    const archived = await access.archiveTechnicalMember(companyId, member.id);
    if (!archived) throw notFound("SPS technical Member not found");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId(req) ?? "local-board",
      action: "sps_technical_member.revoked",
      entityType: "company_membership",
      entityId: archived.id,
      details: { nodeCount: revokedNodes.length },
    });
    res.json({
      member: {
        id: archived.id,
        accountId: archived.principalId,
        status: archived.status,
        joinedAt: archived.createdAt,
        archivedAt: archived.updatedAt,
      },
      revokedNodeCount: revokedNodes.length,
    });
  });

  router.get("/companies/:companyId/sps-nodes", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSpsNodeAdmin(req, companyId);

    const [nodes, grants, runnerGrants, bindings, runners, companyAgents] = await Promise.all([
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
        .from(spsNodeAgentRunnerGrants)
        .where(and(eq(spsNodeAgentRunnerGrants.companyId, companyId), isNull(spsNodeAgentRunnerGrants.revokedAt))),
      db
        .select()
        .from(spsAgentNodeBindings)
        .where(eq(spsAgentNodeBindings.companyId, companyId)),
      db
        .select()
        .from(spsNodeRunnerProfiles)
        .where(eq(spsNodeRunnerProfiles.companyId, companyId))
        .orderBy(spsNodeRunnerProfiles.createdAt),
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
      runners: runners
        .filter((runner) => runner.nodeId === node.id)
        .map((runner) => ({
          ...runner,
          agentGrants: runnerGrants
            .filter((grant) => grant.runnerProfileId === runner.id)
            .map((grant) => ({
              ...grant,
              agent: agentById.get(grant.agentId) ?? null,
            })),
        })),
    })));
  });

  router.get("/projects/:projectId/sps-host-share", async (req, res) => {
    assertSpsHostProjectShareOwner(req);
    const project = await getProjectShareProject(req.params.projectId as string);
    assertCompanyAccess(req, project.companyId);
    const [share, nodes] = await Promise.all([
      db
        .select()
        .from(spsHostProjectShares)
        .where(and(
          eq(spsHostProjectShares.companyId, project.companyId),
          eq(spsHostProjectShares.projectId, project.id),
        ))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          id: spsNodes.id,
          displayName: spsNodes.displayName,
          platform: spsNodes.platform,
          status: spsNodes.status,
          keyVerifiedAt: spsNodes.keyVerifiedAt,
          transportPublicKey: spsNodes.transportPublicKey,
        })
        .from(spsNodes)
        .where(eq(spsNodes.companyId, project.companyId))
        .orderBy(desc(spsNodes.createdAt)),
    ]);
    const grants = share
      ? await db
        .select({ nodeId: spsHostProjectShareNodeGrants.nodeId, revokedAt: spsHostProjectShareNodeGrants.revokedAt })
        .from(spsHostProjectShareNodeGrants)
        .where(and(
          eq(spsHostProjectShareNodeGrants.companyId, project.companyId),
          eq(spsHostProjectShareNodeGrants.shareId, share.id),
        ))
      : [];
    const grantByNodeId = new Map(grants.map((grant) => [grant.nodeId, grant]));
    res.json({
      share: share
        ? {
          id: share.id,
          projectId: share.projectId,
          hostNodeId: share.hostNodeId,
          sharePath: share.sharePath,
          status: share.status,
          createdAt: share.createdAt,
          updatedAt: share.updatedAt,
        }
        : null,
      nodes: nodes.map((node) => ({
        ...node,
        // The Owner Desktop uses this public key to seal a credential for a
        // single Node. It must never receive another Node's private material.
        transportPublicKey: node.transportPublicKey ?? null,
        sourceAccess: grantByNodeId.get(node.id)?.revokedAt ? "revoked" : grantByNodeId.has(node.id) ? "granted" : "none",
      })),
    });
  });

  router.put(
    "/projects/:projectId/sps-host-share",
    validate(upsertSpsHostProjectShareSchema),
    async (req, res) => {
      assertSpsHostProjectShareOwner(req);
      const project = await getProjectShareProject(req.params.projectId as string);
      assertCompanyAccess(req, project.companyId);
      if (!req.body.sharePath.startsWith("\\\\")) {
        throw badRequest("SPS Host project access requires a managed UNC share path");
      }
      const now = new Date();
      const existing = await db
        .select()
        .from(spsHostProjectShares)
        .where(and(
          eq(spsHostProjectShares.companyId, project.companyId),
          eq(spsHostProjectShares.projectId, project.id),
        ))
        .then((rows) => rows[0] ?? null);
      const share = existing
        ? await db
          .update(spsHostProjectShares)
          .set({
            sharePath: req.body.sharePath,
            status: "active",
            updatedAt: now,
          })
          .where(eq(spsHostProjectShares.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
        : await db
          .insert(spsHostProjectShares)
          .values({
            companyId: project.companyId,
            projectId: project.id,
            sharePath: req.body.sharePath,
            createdByUserId: actorUserId(req) ?? "local-board",
          })
          .returning()
          .then((rows) => rows[0]!);
      await logActivity(db, {
        companyId: project.companyId,
        actorType: "user",
        actorId: actorUserId(req) ?? "local-board",
        action: existing ? "sps_host_project_share.updated" : "sps_host_project_share.created",
        entityType: "project",
        entityId: project.id,
        details: { shareId: share.id, hostNodeId: share.hostNodeId ?? null },
      });
      res.json({
        id: share.id,
        projectId: share.projectId,
        hostNodeId: share.hostNodeId,
        sharePath: share.sharePath,
        status: share.status,
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
      });
    },
  );

  router.put(
    "/projects/:projectId/sps-host-share/nodes/:nodeId",
    validate(grantSpsHostProjectShareNodeSchema),
    async (req, res) => {
      assertSpsHostProjectShareOwner(req);
      const project = await getProjectShareProject(req.params.projectId as string);
      assertCompanyAccess(req, project.companyId);
      const [share, node] = await Promise.all([
        db
          .select()
          .from(spsHostProjectShares)
          .where(and(
            eq(spsHostProjectShares.companyId, project.companyId),
            eq(spsHostProjectShares.projectId, project.id),
          ))
          .then((rows) => rows[0] ?? null),
        getNode(req.params.nodeId as string),
      ]);
      if (!share || share.status !== "active") throw badRequest("Configure this Host project share before granting Member source access");
      if (node.companyId !== project.companyId || (share.hostNodeId && node.id === share.hostNodeId)) {
        throw badRequest("Choose an approved Member SPS Node for Host project source access");
      }
      if (node.status !== "active" || !node.keyVerifiedAt || !node.transportPublicKey) {
        throw badRequest("This Member SPS Node must be active and publish a transport public key before it can receive project source access");
      }
      const now = new Date();
      const existing = await db
        .select()
        .from(spsHostProjectShareNodeGrants)
        .where(and(
          eq(spsHostProjectShareNodeGrants.shareId, share.id),
          eq(spsHostProjectShareNodeGrants.nodeId, node.id),
        ))
        .then((rows) => rows[0] ?? null);
      const grant = existing
        ? await db
          .update(spsHostProjectShareNodeGrants)
          .set({
            credentialAlgorithm: req.body.credentialAlgorithm,
            credentialEnvelope: req.body.credentialEnvelope,
            grantedByUserId: actorUserId(req) ?? "local-board",
            revokedAt: null,
            updatedAt: now,
          })
          .where(eq(spsHostProjectShareNodeGrants.id, existing.id))
          .returning()
          .then((rows) => rows[0]!)
        : await db
          .insert(spsHostProjectShareNodeGrants)
          .values({
            companyId: project.companyId,
            shareId: share.id,
            nodeId: node.id,
            credentialAlgorithm: req.body.credentialAlgorithm,
            credentialEnvelope: req.body.credentialEnvelope,
            grantedByUserId: actorUserId(req) ?? "local-board",
          })
          .returning()
          .then((rows) => rows[0]!);
      await logActivity(db, {
        companyId: project.companyId,
        actorType: "user",
        actorId: actorUserId(req) ?? "local-board",
        action: "sps_host_project_share.node_granted",
        entityType: "sps_node",
        entityId: node.id,
        details: { projectId: project.id, shareId: share.id },
      });
      res.json({ id: grant.id, nodeId: grant.nodeId, grantedAt: grant.updatedAt });
    },
  );

  router.delete("/projects/:projectId/sps-host-share/nodes/:nodeId", async (req, res) => {
    assertSpsHostProjectShareOwner(req);
    const project = await getProjectShareProject(req.params.projectId as string);
    assertCompanyAccess(req, project.companyId);
    const share = await db
      .select()
      .from(spsHostProjectShares)
      .where(and(
        eq(spsHostProjectShares.companyId, project.companyId),
        eq(spsHostProjectShares.projectId, project.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!share) throw notFound("SPS Host project share not found");
    const now = new Date();
    const revoked = await db
      .update(spsHostProjectShareNodeGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(spsHostProjectShareNodeGrants.shareId, share.id),
        eq(spsHostProjectShareNodeGrants.nodeId, req.params.nodeId as string),
        isNull(spsHostProjectShareNodeGrants.revokedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!revoked) throw notFound("SPS Host project source access grant not found");
    await logActivity(db, {
      companyId: project.companyId,
      actorType: "user",
      actorId: actorUserId(req) ?? "local-board",
      action: "sps_host_project_share.node_revoked",
      entityType: "sps_node",
      entityId: revoked.nodeId,
      details: { projectId: project.id, shareId: share.id },
    });
    res.status(204).end();
  });

  router.post("/companies/:companyId/sps-nodes", async (req, res) => {
    const result = await nodeOperations.register({ workspaceId: req.params.companyId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

  router.post("/sps-nodes/:nodeId/heartbeat", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "heartbeat", nodeId: req.params.nodeId as string,
      resourceId: null, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

  router.post("/sps-nodes/:nodeId/runners/availability", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "availability", nodeId: req.params.nodeId as string,
      resourceId: null, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

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
    const updated = await revokeNodeExecutionAccess(req, node, {
      action: "sps_node.revoked",
      reason: "SPS Node access was revoked while this command was running.",
    });
    res.json(updated);
  });

  router.post("/sps-nodes/:nodeId/disconnect", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeOwner(req, node);
    const updated = await revokeNodeExecutionAccess(req, node, {
      action: "sps_node.disconnected",
      reason: "This SPS Desktop Node was disconnected by its computer owner.",
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
    assertAgentCanReceiveNodeAccess(agent);
    assertNodeSupportsAgentAdapter(node, agent);

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
    const runnerGrants = await grantCompatibleRunners({
      node,
      agent,
      grantedByUserId: actorUserId(req) ?? "local-board",
    });
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
      details: { agentId: agent.id, runnerGrantCount: runnerGrants.length },
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
    await db
      .update(spsNodeAgentRunnerGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(spsNodeAgentRunnerGrants.nodeId, node.id),
        eq(spsNodeAgentRunnerGrants.agentId, agent.id),
        isNull(spsNodeAgentRunnerGrants.revokedAt),
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

  router.put("/sps-nodes/:nodeId/runners/:runnerProfileId/agent-grants/:agentId", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    const [agent, runner] = await Promise.all([
      getAgent(req.params.agentId as string),
      db
        .select()
        .from(spsNodeRunnerProfiles)
        .where(and(
          eq(spsNodeRunnerProfiles.id, req.params.runnerProfileId as string),
          eq(spsNodeRunnerProfiles.nodeId, node.id),
        ))
        .then((rows) => rows[0] ?? null),
    ]);
    if (agent.companyId !== node.companyId) throw forbidden("Agent belongs to another company");
    if (!runner || runner.companyId !== node.companyId) throw notFound("SPS Node Runner Profile not found");
    const requiredKind = spsNodeCapabilityForAdapter(agent.adapterType);
    if (!requiredKind || runner.kind !== requiredKind) {
      throw badRequest(`Runner \"${runner.label}\" cannot execute Agent \"${agent.name}\".`);
    }
    const nodeGrant = await db
      .select({ id: spsNodeAgentGrants.id })
      .from(spsNodeAgentGrants)
      .where(and(
        eq(spsNodeAgentGrants.nodeId, node.id),
        eq(spsNodeAgentGrants.agentId, agent.id),
        isNull(spsNodeAgentGrants.revokedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!nodeGrant) throw forbidden("Grant this SPS Node to the Agent before granting a Runner Profile");
    const now = new Date();
    const grant = await db
      .insert(spsNodeAgentRunnerGrants)
      .values({
        companyId: node.companyId,
        nodeId: node.id,
        runnerProfileId: runner.id,
        agentId: agent.id,
        grantedByUserId: actorUserId(req) ?? "local-board",
      })
      .onConflictDoUpdate({
        target: [
          spsNodeAgentRunnerGrants.nodeId,
          spsNodeAgentRunnerGrants.runnerProfileId,
          spsNodeAgentRunnerGrants.agentId,
        ],
        set: {
          companyId: node.companyId,
          grantedByUserId: actorUserId(req) ?? "local-board",
          revokedAt: null,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0]!);
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.agent_runner_granted",
      nodeId: node.id,
      details: { agentId: agent.id, runnerProfileId: runner.id },
    });
    res.json(grant);
  });

  router.delete("/sps-nodes/:nodeId/runners/:runnerProfileId/agent-grants/:agentId", async (req, res) => {
    const node = await getNode(req.params.nodeId as string);
    await assertSpsNodeAdmin(req, node.companyId);
    const runner = await db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(and(
        eq(spsNodeRunnerProfiles.id, req.params.runnerProfileId as string),
        eq(spsNodeRunnerProfiles.nodeId, node.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (!runner) throw notFound("SPS Node Runner Profile not found");
    const agent = await getAgent(req.params.agentId as string);
    if (agent.companyId !== node.companyId) throw forbidden("Agent belongs to another company");
    const now = new Date();
    await db
      .update(spsNodeAgentRunnerGrants)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(
        eq(spsNodeAgentRunnerGrants.nodeId, node.id),
        eq(spsNodeAgentRunnerGrants.runnerProfileId, runner.id),
        eq(spsNodeAgentRunnerGrants.agentId, agent.id),
        isNull(spsNodeAgentRunnerGrants.revokedAt),
      ));
    await logNodeMutation(req, {
      companyId: node.companyId,
      action: "sps_node.agent_runner_revoked",
      nodeId: node.id,
      details: { agentId: agent.id, runnerProfileId: runner.id },
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
      assertAgentCanReceiveNodeAccess(agent);
      assertNodeSupportsAgentAdapter(node, agent);

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

  /**
   * Returns a Host-managed Workspace Source route only to the approved Node
   * that owns the matching private transport key. This is intentionally a
   * Node-facing technical primitive: workflow plugins decide when a Source is
   * needed, but neither their UI nor a normal Workspace session can inspect a
   * UNC path or encrypted credential envelope.
   */
  router.post("/sps-nodes/:nodeId/workspace-sources/:sourceId/claim-route", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "source-route", nodeId: req.params.nodeId as string,
      resourceId: req.params.sourceId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

  router.post("/sps-nodes/:nodeId/commands/claim-next", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "claim-command", nodeId: req.params.nodeId as string,
      resourceId: null, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/claim-protocol", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "claim-protocol", nodeId: req.params.nodeId as string,
      resourceId: null, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/commands/:commandId/lease", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "command-lease", nodeId: req.params.nodeId as string,
      resourceId: req.params.commandId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/commands/:commandId/events", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "command-event", nodeId: req.params.nodeId as string,
      resourceId: req.params.commandId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/commands/:commandId/complete", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "command-complete", nodeId: req.params.nodeId as string,
      resourceId: req.params.commandId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

  router.post("/sps-nodes/:nodeId/plugin-runs/claim-next", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "claim-plugin-run", nodeId: req.params.nodeId as string,
      resourceId: null, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/plugin-runs/:runId/lease", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "plugin-lease", nodeId: req.params.nodeId as string,
      resourceId: req.params.runId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/plugin-runs/:runId/events", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "plugin-event", nodeId: req.params.nodeId as string,
      resourceId: req.params.runId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });
  router.post("/sps-nodes/:nodeId/plugin-runs/:runId/complete", async (req, res) => {
    const result = await nodeOperations.invoke({ operation: "plugin-complete", nodeId: req.params.nodeId as string,
      resourceId: req.params.runId as string, payload: req.body }, operationContext(req));
    sendOperationResult(res, result);
  });

  return router;
}
