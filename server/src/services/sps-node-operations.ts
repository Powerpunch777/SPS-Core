import { createHash, createPublicKey, verify } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import {
  agents, heartbeatRuns, projects, spsAgentNodeBindings, spsHostProjectShareNodeGrants,
  spsHostProjectShares, spsWorkspaceSourceNodeGrants, spsWorkspaceSources,
  spsPluginExecutionGrants, spsPluginNodeRunEvents, spsPluginNodeRuns,
  spsNodeCommandEvents, spsNodeCommands, spsNodeAgentGrants,
  spsNodeAgentRunnerGrants, spsNodeHeartbeats, spsNodeRunnerProfiles, spsNodes,
} from "../compat/paperclip/db.js";
import {
  createSpsNodeSchema, reportSpsNodeRunnerAvailabilitySchema,
  spsNodeHeartbeatMessage, spsNodeHeartbeatSchema, spsNodeCommandCompleteSchema,
  spsPluginNodeRunCompleteSchema, spsNodeCommandEventSchema,
  spsNodeSignedRequestMessage, spsNodeSignedRequestSchema,
  spsNodeCapabilityForAdapter, spsNodeExecutableRuntimeKindSchema,
  spsNodeSupportsAdapter, spsNodeUsageReportSchema,
  type SpsNodeRunnerProfile,
} from "../compat/paperclip/shared.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { hasSpsSessionCancellation, } from "../services/sps-agent-session-runs.js";
import { createSpsNodeUsageReceipt } from "../services/sps-node-usage.js";
import { createSpsNodeCompletionReceiptDigest } from "../services/sps-node-completion-receipt.js";
import { normalizeSpsPluginExecutionTimeout } from "../services/sps-execution-timeout.js";
import { assertSpsWorkspaceExecutionActive, lockSpsWorkspaceExecutionControl, withSpsWorkspaceExecutionAdmission } from "../services/sps-workspace-execution-control.js";
import { heartbeatService } from "../compat/paperclip/control-plane.js";

type Node = typeof spsNodes.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type NodeDatabase = Db | DbTransaction;
type Command = typeof spsNodeCommands.$inferSelect;
type PluginRun = typeof spsPluginNodeRuns.$inferSelect;
type Operation = "heartbeat" | "availability" | "source-route" | "claim-command"
  | "command-lease" | "command-event" | "command-complete" | "claim-plugin-run"
  | "plugin-lease" | "plugin-event" | "plugin-complete";
type Mutation = { companyId: string; action: string; nodeId: string; details?: Record<string, unknown> };
export type SpsNodeOperationContext = Readonly<{
  userId: string;
  authorizeWorkspace(companyId: string): Promise<void> | void;
  authorizeNode(node: Node): Promise<void> | void;
  logMutation(input: Mutation): Promise<void> | void;
  signatureMethod?: string;
  signaturePath?: string;
  /** @deprecated Retained for compatibility; elapsed time is not termination evidence. */
  requeueStaleClaims?: boolean;
  syncRunnerGrants?: boolean;
  assertCurrent?(): void;
  afterCommit?(effect: () => Promise<unknown> | unknown): Promise<void> | void;
}>;
export type SpsNodeOperationResult = Readonly<{ status: number; data: unknown }>;

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

function signedPayload(body: Record<string, unknown>) {
  const { timestamp: _timestamp, nonce: _nonce, signature: _signature, ...payload } = body;
  return payload;
}

export function createSpsNodeOperations(dbInput: NodeDatabase, { effectDb = dbInput as Db }: { effectDb?: Db } = {}) {
  const db = dbInput as Db;
  async function transaction<T>(work: (tx: NodeDatabase) => Promise<T>): Promise<T> {
    if (typeof (dbInput as Db).transaction === "function") {
      return await (dbInput as Db).transaction(tx => work(tx as NodeDatabase));
    }
    return await work(dbInput);
  }
  async function withWorkspaceExecutionAdmission<T>(companyId: string, action: (tx: NodeDatabase, epoch: string) => Promise<T>): Promise<T> {
    return withSpsWorkspaceExecutionAdmission(dbInput as Db, companyId, async (tx, epoch) => action(tx as NodeDatabase, epoch));
  }
  async function getNode(nodeId: string) {
    const node = await db.select().from(spsNodes).where(eq(spsNodes.id, nodeId)).then(rows => rows[0] ?? null);
    if (!node) throw notFound("SPS Node not found");
    return node;
  }
  async function getAgent(agentId: string) {
    return await db.select().from(agents).where(eq(agents.id, agentId)).then(rows => rows[0] ?? null);
  }
  async function assertSignedRequest(node: Node, body: Record<string, unknown>, context: SpsNodeOperationContext) {
    context.assertCurrent?.();
    await context.authorizeNode(node);
    context.assertCurrent?.();
    if (!context.signatureMethod || !context.signaturePath) throw forbidden("SPS Node request signature is invalid");
    const signed = spsNodeSignedRequestSchema.parse(body);
    const signedAt = new Date(signed.timestamp), now = new Date(), maxClockSkewMs = 5 * 60 * 1000;
    if (Math.abs(now.getTime() - signedAt.getTime()) > maxClockSkewMs) throw badRequest("SPS Node request timestamp is outside the allowed clock-skew window");
    let key: ReturnType<typeof createPublicKey>;
    try { key = createPublicKey(node.publicKey); } catch { throw badRequest("SPS Node public key is not a supported public key format"); }
    if (key.asymmetricKeyType !== "ed25519") throw badRequest("SPS Node public key must use Ed25519");
    const bodySha256 = createHash("sha256").update(canonicalJson(signedPayload(body)), "utf8").digest("hex");
    const message = spsNodeSignedRequestMessage({ nodeId: node.id, method: context.signatureMethod,
      path: context.signaturePath, timestamp: signed.timestamp, nonce: signed.nonce, bodySha256 });
    if (!verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signed.signature, "base64"))) throw forbidden("SPS Node request signature is invalid");
    const nonceHash = createHash("sha256").update(`request:${node.id}:${signed.nonce}`).digest("hex");
    const nonceExpiry = new Date(signedAt.getTime() + maxClockSkewMs + 60_000);
    await db.delete(spsNodeHeartbeats).where(lt(spsNodeHeartbeats.expiresAt, now));
    const replay = await db.select({ id: spsNodeHeartbeats.id }).from(spsNodeHeartbeats)
      .where(eq(spsNodeHeartbeats.nonceHash, nonceHash)).then(rows => rows[0] ?? null);
    if (replay) throw forbidden("SPS Node request nonce has already been used");
    await db.insert(spsNodeHeartbeats).values({ nodeId: node.id, nonceHash, signedAt, expiresAt: nonceExpiry });
  }
  async function commandHasCurrentAuthority(node: Node, command: Command) {
    if (node.status !== "active" || !node.keyVerifiedAt) return false;
    const [grant, binding, runnerGrants] = await Promise.all([
      db.select({ id: spsNodeAgentGrants.id }).from(spsNodeAgentGrants).where(and(
        eq(spsNodeAgentGrants.companyId, node.companyId), eq(spsNodeAgentGrants.nodeId, node.id),
        eq(spsNodeAgentGrants.agentId, command.agentId), isNull(spsNodeAgentGrants.revokedAt))).then(rows => rows[0] ?? null),
      db.select({ id: spsAgentNodeBindings.id }).from(spsAgentNodeBindings).where(and(
        eq(spsAgentNodeBindings.companyId, node.companyId), eq(spsAgentNodeBindings.nodeId, node.id),
        eq(spsAgentNodeBindings.agentId, command.agentId))).then(rows => rows[0] ?? null),
      command.runnerProfileId ? db.select({ runnerProfileId: spsNodeAgentRunnerGrants.runnerProfileId })
        .from(spsNodeAgentRunnerGrants).where(and(eq(spsNodeAgentRunnerGrants.companyId, node.companyId),
          eq(spsNodeAgentRunnerGrants.nodeId, node.id), eq(spsNodeAgentRunnerGrants.agentId, command.agentId),
          isNull(spsNodeAgentRunnerGrants.revokedAt))) : Promise.resolve([]),
    ]);
    if (!grant || !binding || command.runnerProfileId && !runnerGrants.some(row => row.runnerProfileId === command.runnerProfileId)) return false;
    const workspaceAccess = command.workspaceAccess as Record<string, unknown> | null;
    if (workspaceAccess?.kind !== "sps_host_share") return true;
    const shareId = typeof workspaceAccess.shareId === "string" ? workspaceAccess.shareId : null;
    if (!shareId) return false;
    const [share, sourceGrant] = await Promise.all([
      db.select({ sharePath: spsHostProjectShares.sharePath }).from(spsHostProjectShares).where(and(
        eq(spsHostProjectShares.id, shareId), eq(spsHostProjectShares.companyId, node.companyId),
        eq(spsHostProjectShares.status, "active"))).then(rows => rows[0] ?? null),
      db.select({ id: spsHostProjectShareNodeGrants.id, credentialAlgorithm: spsHostProjectShareNodeGrants.credentialAlgorithm })
        .from(spsHostProjectShareNodeGrants).where(and(
        eq(spsHostProjectShareNodeGrants.shareId, shareId), eq(spsHostProjectShareNodeGrants.nodeId, node.id),
        eq(spsHostProjectShareNodeGrants.companyId, node.companyId), isNull(spsHostProjectShareNodeGrants.revokedAt))).then(rows => rows[0] ?? null),
    ]);
    return Boolean(share?.sharePath && command.cwdHint === share.sharePath && workspaceAccess.sharePath === share.sharePath && sourceGrant
      && (sourceGrant.credentialAlgorithm === "rsa-oaep-sha256" || sourceGrant.credentialAlgorithm === "rsa-oaep-sha256+a256gcm"));
  }
  async function commandRunnerCanStart(command: Command) {
    if (!command.runnerProfileId) return true;
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.id, command.runnerProfileId)).then(rows => rows[0] ?? null);
    return runner !== null && runner.credentialStatus !== "auth_required"
      && (runner.availabilityStatus === "available" || runner.availabilityStatus === "unknown");
  }
  async function pluginRunHasCurrentAuthority(node: Node, run: PluginRun) {
    if (node.status !== "active" || !node.keyVerifiedAt) return false;
    const [grant, runner] = await Promise.all([
      db.select().from(spsPluginExecutionGrants).where(and(eq(spsPluginExecutionGrants.id, run.executionGrantId),
        eq(spsPluginExecutionGrants.companyId, node.companyId), eq(spsPluginExecutionGrants.pluginKey, run.pluginKey),
        eq(spsPluginExecutionGrants.subjectKey, run.subjectKey), eq(spsPluginExecutionGrants.nodeId, node.id),
        eq(spsPluginExecutionGrants.runnerProfileId, run.runnerProfileId), eq(spsPluginExecutionGrants.status, "active"),
        isNull(spsPluginExecutionGrants.revokedAt))).then(rows => rows[0] ?? null),
      db.select().from(spsNodeRunnerProfiles).where(and(eq(spsNodeRunnerProfiles.id, run.runnerProfileId),
        eq(spsNodeRunnerProfiles.companyId, node.companyId), eq(spsNodeRunnerProfiles.nodeId, node.id))).then(rows => rows[0] ?? null),
    ]);
    if (!grant || !runner || !spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind).success
      || (grant.workspaceSourceId ?? null) !== (run.workspaceSourceId ?? null)) return false;
    if (!run.workspaceSourceId) return true;
    const [source, sourceGrant] = await Promise.all([
      db.select({ id: spsWorkspaceSources.id, sharePath: spsWorkspaceSources.sharePath }).from(spsWorkspaceSources).where(and(
      eq(spsWorkspaceSources.id, run.workspaceSourceId), eq(spsWorkspaceSources.companyId, node.companyId),
      eq(spsWorkspaceSources.status, "active"))).then(rows => rows[0] ?? null),
      db.select({ id: spsWorkspaceSourceNodeGrants.id, credentialAlgorithm: spsWorkspaceSourceNodeGrants.credentialAlgorithm })
        .from(spsWorkspaceSourceNodeGrants).where(and(
        eq(spsWorkspaceSourceNodeGrants.sourceId, run.workspaceSourceId), eq(spsWorkspaceSourceNodeGrants.companyId, node.companyId),
        eq(spsWorkspaceSourceNodeGrants.nodeId, node.id), isNull(spsWorkspaceSourceNodeGrants.revokedAt))).then(rows => rows[0] ?? null),
    ]);
    return Boolean(source?.sharePath && run.cwdHint === source.sharePath && sourceGrant
      && (sourceGrant.credentialAlgorithm === "rsa-oaep-sha256" || sourceGrant.credentialAlgorithm === "rsa-oaep-sha256+a256gcm"));
  }
  async function pluginRunRunnerCanStart(run: PluginRun) {
    const runner = await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.id, run.runnerProfileId)).then(rows => rows[0] ?? null);
    return runner !== null && spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind).success
      && runner.credentialStatus !== "auth_required" && (runner.availabilityStatus === "available" || runner.availabilityStatus === "unknown");
  }
  async function failActiveNodeCommand(input: { commandId: string; reason: string }) {
    const now = new Date();
    await db.update(spsNodeCommands).set({ status: "failed", error: input.reason, finishedAt: now, updatedAt: now })
      .where(and(eq(spsNodeCommands.id, input.commandId), inArray(spsNodeCommands.status, ["claimed", "running"] as const)));
  }
  async function failActivePluginRun(input: { runId: string; reason: string }) {
    const now = new Date();
    await db.update(spsPluginNodeRuns).set({ status: "failed", error: input.reason, finishedAt: now, updatedAt: now })
      .where(and(eq(spsPluginNodeRuns.id, input.runId), inArray(spsPluginNodeRuns.status, ["claimed", "running"] as const)));
  }

  async function register(input: { workspaceId: string; payload: unknown }, context: SpsNodeOperationContext): Promise<SpsNodeOperationResult> {
    await context.authorizeWorkspace(input.workspaceId);
    const body = createSpsNodeSchema.parse(input.payload);
    const userId = context.userId;
    if (!userId) throw forbidden("Board authentication required");
    const registrationCapabilities = body.capabilities.length ? body.capabilities : (body.runners ?? []).map((runner: SpsNodeRunnerProfile) => ({
      kind: runner.kind, label: runner.label, version: runner.version ?? null, ...(runner.models?.length ? { models: runner.models } : {}),
    }));
    const now = new Date();
    const existing = await db.select().from(spsNodes).where(and(eq(spsNodes.companyId, input.workspaceId), eq(spsNodes.publicKey, body.publicKey))).then(rows => rows[0] ?? null);
    if (existing && existing.ownerUserId !== userId) throw forbidden("This SPS Node belongs to another company member");
    const node = existing ? await db.update(spsNodes).set({ displayName: body.displayName,
      transportPublicKey: body.transportPublicKey ?? null, platform: body.platform, appVersion: body.appVersion ?? null,
      capabilities: registrationCapabilities, lastSeenAt: now, updatedAt: now }).where(eq(spsNodes.id, existing.id)).returning().then(rows => rows[0]!)
      : await db.insert(spsNodes).values({ companyId: input.workspaceId, ownerUserId: userId, displayName: body.displayName,
        publicKey: body.publicKey, transportPublicKey: body.transportPublicKey ?? null, platform: body.platform,
        appVersion: body.appVersion ?? null, capabilities: registrationCapabilities, lastSeenAt: now }).returning().then(rows => rows[0]!);
    const runners = body.runners ?? registrationCapabilities.map((capability: typeof registrationCapabilities[number]) => ({
      runnerKey: `${capability.kind}:default`, kind: capability.kind, label: capability.label, version: capability.version ?? null,
      ...(capability.models?.length ? { models: capability.models } : {}),
    }));
    const runnerProfiles = await reconcileRunnerProfiles(node, runners);
    if (context.syncRunnerGrants !== false) await syncExistingNodeAgentRunnerGrants(node, userId);
    await context.logMutation({ companyId: input.workspaceId, action: existing ? "sps_node.updated" : "sps_node.registered",
      nodeId: node.id, details: { status: node.status, capabilityKinds: node.capabilities.map(item => item.kind), runnerCount: runnerProfiles.length } });
    return { status: existing ? 200 : 201, data: { ...node, runners: runnerProfiles } };
  }

  async function reconcileRunnerProfiles(node: Node, runners: ReadonlyArray<SpsNodeRunnerProfile>) {
    const now = new Date(), seen = new Set<string>(), profiles = [];
    for (const runner of runners) {
      if (seen.has(runner.runnerKey)) continue;
      seen.add(runner.runnerKey);
      const availability = runner.availability, observedAt = availability?.observedAt ? new Date(availability.observedAt) : now;
      const retryAfter = availability?.retryAfter ? new Date(availability.retryAfter) : null;
      const profile = await db.insert(spsNodeRunnerProfiles).values({ companyId: node.companyId, nodeId: node.id,
        runnerKey: runner.runnerKey, kind: runner.kind, label: runner.label, version: runner.version ?? null,
        models: runner.models ?? [], profileLabel: runner.profileLabel ?? null, credentialStatus: runner.credentialStatus ?? "unknown",
        availabilityStatus: availability?.status ?? "unknown", availabilityDetail: availability?.detail ?? null,
        availabilitySource: availability?.source ?? "node_probe", availabilityConfidence: availability?.confidence ?? null,
        availabilityObservedAt: observedAt, retryAfter, updatedAt: now }).onConflictDoUpdate({
        target: [spsNodeRunnerProfiles.nodeId, spsNodeRunnerProfiles.runnerKey], set: {
          kind: runner.kind, label: runner.label, version: runner.version ?? null, models: runner.models ?? [],
          profileLabel: runner.profileLabel ?? null, credentialStatus: runner.credentialStatus ?? "unknown",
          availabilityStatus: availability?.status ?? "unknown", availabilityDetail: availability?.detail ?? null,
          availabilitySource: availability?.source ?? "node_probe", availabilityConfidence: availability?.confidence ?? null,
          availabilityObservedAt: observedAt, retryAfter, updatedAt: now,
        },
      }).returning().then(rows => rows[0]!);
      profiles.push(profile);
    }
    return profiles;
  }
  async function grantCompatibleRunners(input: { node: Node; agent: typeof agents.$inferSelect; grantedByUserId: string; restoreRevoked?: boolean }) {
    const requiredKind = spsNodeCapabilityForAdapter(input.agent.adapterType);
    if (!requiredKind) return [];
    const now = new Date();
    const profiles = await db.select().from(spsNodeRunnerProfiles).where(and(eq(spsNodeRunnerProfiles.companyId, input.node.companyId),
      eq(spsNodeRunnerProfiles.nodeId, input.node.id), eq(spsNodeRunnerProfiles.kind, requiredKind)));
    return await Promise.all(profiles.map(async runner => {
      const existing = await db.select().from(spsNodeAgentRunnerGrants).where(and(eq(spsNodeAgentRunnerGrants.nodeId, input.node.id),
        eq(spsNodeAgentRunnerGrants.runnerProfileId, runner.id), eq(spsNodeAgentRunnerGrants.agentId, input.agent.id))).then(rows => rows[0] ?? null);
      if (existing?.revokedAt && input.restoreRevoked === false) return existing;
      if (existing) return await db.update(spsNodeAgentRunnerGrants).set({ companyId: input.node.companyId,
        grantedByUserId: input.grantedByUserId, revokedAt: null, updatedAt: now }).where(eq(spsNodeAgentRunnerGrants.id, existing.id)).returning().then(rows => rows[0]!);
      return await db.insert(spsNodeAgentRunnerGrants).values({ companyId: input.node.companyId, nodeId: input.node.id,
        runnerProfileId: runner.id, agentId: input.agent.id, grantedByUserId: input.grantedByUserId }).returning().then(rows => rows[0]!);
    }));
  }
  async function syncExistingNodeAgentRunnerGrants(node: Node, userId: string) {
    const grants = await db.select({ agent: agents }).from(spsNodeAgentGrants).innerJoin(agents, eq(agents.id, spsNodeAgentGrants.agentId))
      .where(and(eq(spsNodeAgentGrants.companyId, node.companyId), eq(spsNodeAgentGrants.nodeId, node.id), isNull(spsNodeAgentGrants.revokedAt)));
    await Promise.all(grants.map(({ agent }) => grantCompatibleRunners({ node, agent, grantedByUserId: userId, restoreRevoked: false })));
  }

  async function invoke(input: { operation: Operation; nodeId: string; resourceId: string | null; payload: unknown }, context: SpsNodeOperationContext): Promise<SpsNodeOperationResult> {
    const node = await getNode(input.nodeId);
    const body = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload as Record<string, unknown> : {};
    if (input.operation === "heartbeat") {
      await context.authorizeNode(node);
      if (node.status === "revoked") throw forbidden("This SPS Node has been revoked");
      const heartbeat = spsNodeHeartbeatSchema.parse(body), signedAt = new Date(heartbeat.timestamp), now = new Date(), maxClockSkewMs = 5 * 60 * 1000;
      if (Math.abs(now.getTime() - signedAt.getTime()) > maxClockSkewMs) throw badRequest("SPS Node heartbeat timestamp is outside the allowed clock-skew window");
      let key: ReturnType<typeof createPublicKey>;
      try { key = createPublicKey(node.publicKey); } catch { throw badRequest("SPS Node public key is not a supported public key format"); }
      if (key.asymmetricKeyType !== "ed25519") throw badRequest("SPS Node public key must use Ed25519");
      const message = spsNodeHeartbeatMessage({ nodeId: node.id, timestamp: heartbeat.timestamp, nonce: heartbeat.nonce });
      if (!verify(null, Buffer.from(message, "utf8"), key, Buffer.from(heartbeat.signature, "base64"))) throw forbidden("SPS Node heartbeat signature is invalid");
      const nonceHash = createHash("sha256").update(heartbeat.nonce).digest("hex"), nonceExpiry = new Date(signedAt.getTime() + maxClockSkewMs + 60_000);
      await db.delete(spsNodeHeartbeats).where(lt(spsNodeHeartbeats.expiresAt, now));
      const replay = await db.select({ id: spsNodeHeartbeats.id }).from(spsNodeHeartbeats).where(eq(spsNodeHeartbeats.nonceHash, nonceHash)).then(rows => rows[0] ?? null);
      if (replay) throw forbidden("SPS Node heartbeat nonce has already been used");
      await db.insert(spsNodeHeartbeats).values({ nodeId: node.id, nonceHash, signedAt, expiresAt: nonceExpiry });
      const updated = await db.update(spsNodes).set({ keyVerifiedAt: node.keyVerifiedAt ?? now, lastSeenAt: now, updatedAt: now })
        .where(eq(spsNodes.id, node.id)).returning().then(rows => rows[0]!);
      return { status: 200, data: updated };
    }
    await assertSignedRequest(node, body, context);
    if (input.operation === "availability") {
      const report = reportSpsNodeRunnerAvailabilitySchema.parse(body), runnerKeys = report.runners.map(runner => runner.runnerKey);
      const profiles = await db.select().from(spsNodeRunnerProfiles).where(and(eq(spsNodeRunnerProfiles.nodeId, node.id), inArray(spsNodeRunnerProfiles.runnerKey, runnerKeys)));
      const byKey = new Map(profiles.map(profile => [profile.runnerKey, profile]));
      const missing = runnerKeys.find(key => !byKey.has(key));
      if (missing) throw badRequest(`SPS Node runner "${missing}" is not registered on this Node.`);
      const now = new Date();
      const updated = await transaction(async tx => Promise.all(report.runners.map(async runner => {
        const profile = byKey.get(runner.runnerKey)!;
        return await tx.update(spsNodeRunnerProfiles).set({ credentialStatus: runner.credentialStatus ?? profile.credentialStatus,
          availabilityStatus: runner.availability.status, availabilityDetail: runner.availability.detail ?? null,
          availabilitySource: runner.availability.source, availabilityConfidence: runner.availability.confidence ?? null,
          availabilityObservedAt: new Date(runner.availability.observedAt), retryAfter: runner.availability.retryAfter ? new Date(runner.availability.retryAfter) : null,
          updatedAt: now }).where(eq(spsNodeRunnerProfiles.id, profile.id)).returning().then(rows => rows[0]!);
      })));
      await db.update(spsNodes).set({ lastSeenAt: now, updatedAt: now }).where(eq(spsNodes.id, node.id));
      await context.logMutation({ companyId: node.companyId, action: "sps_node.runner_availability_reported", nodeId: node.id,
        details: { runners: updated.map(runner => ({ runnerKey: runner.runnerKey, status: runner.availabilityStatus, source: runner.availabilitySource })) } });
      return { status: 200, data: updated };
    }
    if (input.operation === "source-route") {
      if (node.status !== "active" || !node.keyVerifiedAt || !node.transportPublicKey) throw forbidden("This SPS Node is not approved for Workspace Source access");
      const sourceId = input.resourceId;
      if (!sourceId) throw badRequest("SPS Workspace Source route claims require a Source id");
      const [source, grant] = await Promise.all([
        db.select().from(spsWorkspaceSources).where(and(eq(spsWorkspaceSources.id, sourceId), eq(spsWorkspaceSources.companyId, node.companyId))).then(rows => rows[0] ?? null),
        db.select().from(spsWorkspaceSourceNodeGrants).where(and(eq(spsWorkspaceSourceNodeGrants.sourceId, sourceId),
          eq(spsWorkspaceSourceNodeGrants.companyId, node.companyId), eq(spsWorkspaceSourceNodeGrants.nodeId, node.id), isNull(spsWorkspaceSourceNodeGrants.revokedAt))).then(rows => rows[0] ?? null),
      ]);
      if (!source || source.status !== "active" || !source.sharePath) throw notFound("This SPS Workspace Source has no active transport route");
      if (!grant) throw forbidden("This SPS Node has not been granted this Workspace Source");
      if (grant.credentialAlgorithm !== "rsa-oaep-sha256" && grant.credentialAlgorithm !== "rsa-oaep-sha256+a256gcm") throw badRequest("This SPS Workspace Source uses an unsupported Node credential envelope");
      await context.logMutation({ companyId: node.companyId, action: "sps_workspace_source.node_route_claimed", nodeId: node.id, details: { sourceId } });
      return { status: 200, data: { kind: "sps_workspace_source", sourceId, sharePath: source.sharePath,
        credentialAlgorithm: grant.credentialAlgorithm, credentialEnvelope: grant.credentialEnvelope } };
    }
    if (input.operation === "claim-command") {
      if (node.status !== "active" || !node.keyVerifiedAt) throw forbidden("This SPS Node is not approved for command execution");
      return await withWorkspaceExecutionAdmission(node.companyId, async (tx, workspaceExecutionEpoch) => {
      const now = new Date();
      while (true) {
        context.assertCurrent?.();
        const candidate = await tx.select().from(spsNodeCommands).where(and(eq(spsNodeCommands.nodeId, node.id), eq(spsNodeCommands.status, "queued")))
          .orderBy(spsNodeCommands.createdAt).limit(1).then(rows => rows[0] ?? null);
        context.assertCurrent?.();
        if (!candidate) return { status: 204, data: null };
        if (candidate.workspaceExecutionEpoch !== workspaceExecutionEpoch) {
          await tx.update(spsNodeCommands).set({ status: "failed", error: "Workspace execution generation changed before command claim.", finishedAt: now, updatedAt: now })
            .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")));
          continue;
        }
        if (!await commandHasCurrentAuthority(node, candidate)) {
          context.assertCurrent?.();
          await tx.update(spsNodeCommands).set({ status: "failed", error: "SPS Node access was revoked or reassigned before this command was claimed.", finishedAt: now, updatedAt: now })
            .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")));
          continue;
        }
        if (!await commandRunnerCanStart(candidate)) {
          context.assertCurrent?.();
          await tx.update(spsNodeCommands).set({ status: "failed", error: "The selected SPS Node Runner Profile is unavailable, requires a local sign-in, or no longer exists.", finishedAt: now, updatedAt: now })
            .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")));
          continue;
        }
        const agent = await getAgent(candidate.agentId), runtimeKind = agent ? spsNodeCapabilityForAdapter(agent.adapterType) : null;
        if (!agent || agent.companyId !== node.companyId || !runtimeKind) {
          context.assertCurrent?.();
          await tx.update(spsNodeCommands).set({ status: "failed", error: "SPS Node command could not be matched to an approved Agent runtime.", finishedAt: now, updatedAt: now })
            .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued")));
          continue;
        }
        context.assertCurrent?.();
        const claimed = await tx.update(spsNodeCommands).set({ status: "claimed", claimedAt: now, startedAt: now, updatedAt: now })
          .where(and(eq(spsNodeCommands.id, candidate.id), eq(spsNodeCommands.status, "queued"))).returning().then(rows => rows[0] ?? null);
        if (claimed) return { status: 200, data: { ...claimed, runtimeKind } };
      }
      });
    }
    if (input.operation === "command-lease") {
      const commandId = input.resourceId!;
      const command = await db.select().from(spsNodeCommands).where(and(eq(spsNodeCommands.id, commandId), eq(spsNodeCommands.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!command) throw notFound("SPS Node command not found");
      if (command.status !== "claimed" && command.status !== "running") return { status: 200, data: { active: false, status: command.status, error: command.error ?? null } };
      try { await assertSpsWorkspaceExecutionActive(db, node.companyId, command.workspaceExecutionEpoch); }
      catch { return { status: 200, data: { active: false, status: "cancelled", error: "Workspace execution was stopped" } }; }
      const parent = command.heartbeatRunId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, command.heartbeatRunId)).then(rows => rows[0] ?? null) : null;
      if (command.heartbeatRunId && (!parent || !["queued", "running"].includes(parent.status) || hasSpsSessionCancellation(parent))) return { status: 200, data: { active: false, status: "cancelling", error: "Agent session cancellation requested" } };
      if (!await commandHasCurrentAuthority(node, command)) {
        await failActiveNodeCommand({ commandId: command.id, reason: "SPS Node access was revoked or reassigned while this command was running." });
        return { status: 200, data: { active: false, status: "failed", error: "SPS Node access was revoked or reassigned while this command was running." } };
      }
      return { status: 200, data: { active: true, status: command.status, error: null } };
    }
    if (input.operation === "command-event") {
      const event = spsNodeCommandEventSchema.parse(body), commandId = input.resourceId!;
      const command = await db.select().from(spsNodeCommands).where(and(eq(spsNodeCommands.id, commandId), eq(spsNodeCommands.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!command) throw notFound("SPS Node command not found");
      await assertSpsWorkspaceExecutionActive(db, node.companyId, command.workspaceExecutionEpoch);
      if (command.status !== "claimed" && command.status !== "running") throw forbidden("SPS Node command is not accepting output");
      if (!await commandHasCurrentAuthority(node, command)) {
        await failActiveNodeCommand({ commandId: command.id, reason: "SPS Node access was revoked or reassigned while this command was running." });
        throw forbidden("SPS Node command access was revoked while it was running");
      }
      if (event.sequence !== command.lastEventSeq + 1) throw badRequest("SPS Node command output sequence is out of order");
      const now = new Date();
      await transaction(async tx => {
        await lockSpsWorkspaceExecutionControl(tx, node.companyId);
        await assertSpsWorkspaceExecutionActive(tx, node.companyId, command.workspaceExecutionEpoch);
        const accepted = await tx.update(spsNodeCommands).set({ status: "running", lastEventSeq: event.sequence, updatedAt: now })
          .where(and(eq(spsNodeCommands.id, command.id), inArray(spsNodeCommands.status, ["claimed", "running"]), eq(spsNodeCommands.lastEventSeq, event.sequence - 1))).returning({ id: spsNodeCommands.id });
        if (!accepted.length) throw forbidden("SPS Node command stopped accepting output");
        await tx.insert(spsNodeCommandEvents).values({ commandId: command.id, sequence: event.sequence, stream: event.stream, body: event.body });
      });
      return { status: 204, data: null };
    }
    if (input.operation === "command-complete") {
      const completion = spsNodeCommandCompleteSchema.parse(body), commandId = input.resourceId!;
      const command = await db.select().from(spsNodeCommands).where(and(eq(spsNodeCommands.id, commandId), eq(spsNodeCommands.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!command) throw notFound("SPS Node command not found");
      if (["succeeded", "failed", "cancelled"].includes(command.status)) return { status: 200, data: command };
      if (command.status !== "claimed" && command.status !== "running" && command.status !== "cancelling") throw forbidden("SPS Node command is not active");
      if (command.status !== "cancelling" && !await commandHasCurrentAuthority(node, command)) {
        await failActiveNodeCommand({ commandId: command.id, reason: "SPS Node access was revoked or reassigned while this command was running." });
        const failed = await db.select().from(spsNodeCommands).where(eq(spsNodeCommands.id, command.id)).then(rows => rows[0]!);
        return { status: 200, data: failed };
      }
      const { updated, cancelled } = await transaction(async tx => {
        const control = await lockSpsWorkspaceExecutionControl(tx, node.companyId);
        const commandEpoch = BigInt(command.workspaceExecutionEpoch ?? "0"), currentEpoch = BigInt(control.epoch);
        if (commandEpoch > currentEpoch) throw forbidden("SPS Node command generation is invalid");
        const cancellationRequested = command.status === "cancelling" || commandEpoch < currentEpoch || control.state === "stopped";
        if (!cancellationRequested) await assertSpsWorkspaceExecutionActive(tx, node.companyId, command.workspaceExecutionEpoch);
        const parent = command.heartbeatRunId ? await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, command.heartbeatRunId)).for("update").then(rows => rows[0]) : null;
        const updated = await tx.update(spsNodeCommands).set({ status: cancellationRequested ? "cancelled" : completion.status, exitCode: completion.exitCode,
          signal: completion.signal ?? null, timedOut: completion.timedOut ? 1 : 0, error: cancellationRequested ? command.error ?? "Workspace execution was stopped." : completion.error ?? null,
          completionReceiptDigest: createSpsNodeCompletionReceiptDigest({ kind: "agent-command", nodeId: command.nodeId,
            commandId: command.id, completion }),
          finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(spsNodeCommands.id, command.id),
          eq(spsNodeCommands.nodeId, node.id),
          inArray(spsNodeCommands.status, ["claimed", "running", "cancelling"]))).returning().then(rows => rows[0] ?? null);
        // Another signed completion request may have committed while this
        // request waited for the execution-control lock. Do not return the
        // stale pre-transaction snapshot as if it were still active.
        if (!updated) return { updated: null, cancelled: false };
        if (!parent) return { updated, cancelled: false };
        const cancellationRequestedForParent = cancellationRequested || hasSpsSessionCancellation(parent);
        const parentContext = cancellationRequestedForParent && !hasSpsSessionCancellation(parent)
          ? { ...parent.contextSnapshot, spsSessionCancellationRequested: true,
              spsSessionCancellationTermination: "pending", spsSessionCancellationWasQueued: parent.status === "queued" }
          : parent.contextSnapshot;
        const receipts = { ...(parentContext?.spsNodeCompletionReceipts as Record<string, unknown> | undefined), [command.id]: true };
        let terminationConfirmed = false;
        if (cancellationRequestedForParent) {
          const others = await tx.select({ id: spsNodeCommands.id }).from(spsNodeCommands).where(and(
            eq(spsNodeCommands.heartbeatRunId, parent.id), inArray(spsNodeCommands.status, ["claimed", "running", "cancelling"]),
          )).limit(1);
          terminationConfirmed = others.length === 0;
        }
        await tx.update(heartbeatRuns).set({ contextSnapshot: {
          ...parentContext,
          spsNodeCompletionReceipts: receipts,
          ...(terminationConfirmed ? { spsSessionCancellationTermination: "confirmed" } : {}),
        } }).where(eq(heartbeatRuns.id, parent.id));
        return { updated, cancelled: terminationConfirmed };
      });
      if (cancelled && command.heartbeatRunId) {
        const effect = () => heartbeatService(effectDb).cancelRun(command.heartbeatRunId!);
        if (context.afterCommit) await context.afterCommit(effect);
        else await effect();
      }
      const current = updated ?? await db.select().from(spsNodeCommands)
        .where(and(eq(spsNodeCommands.id, command.id), eq(spsNodeCommands.nodeId, node.id)))
        .then(rows => rows[0] ?? null);
      if (!current) throw notFound("SPS Node command not found");
      return { status: 200, data: current };
    }
    if (input.operation === "claim-plugin-run") {
      if (node.status !== "active" || !node.keyVerifiedAt) throw forbidden("This SPS Node is not approved for plugin execution");
      return await withWorkspaceExecutionAdmission(node.companyId, async (tx, workspaceExecutionEpoch) => {
      const now = new Date();
      while (true) {
        context.assertCurrent?.();
        const candidate = await tx.select().from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.nodeId, node.id), eq(spsPluginNodeRuns.status, "queued")))
          .orderBy(spsPluginNodeRuns.createdAt).limit(1).then(rows => rows[0] ?? null);
        context.assertCurrent?.();
        if (!candidate) return { status: 204, data: null };
        if (candidate.workspaceExecutionEpoch !== workspaceExecutionEpoch) {
          await tx.update(spsPluginNodeRuns).set({ status: "cancelled", error: "Workspace execution generation changed before plugin claim.", finishedAt: now, updatedAt: now })
            .where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued")));
          continue;
        }
        let timeoutMs: number | null;
        try { timeoutMs = normalizeSpsPluginExecutionTimeout(candidate.timeoutMs); }
        catch {
          context.assertCurrent?.();
          await tx.update(spsPluginNodeRuns).set({ status: "failed", error: "Invalid SPS plugin execution timeout.", finishedAt: now, updatedAt: now }).where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued")));
          continue;
        }
        if (!await pluginRunHasCurrentAuthority(node, candidate)) {
          context.assertCurrent?.();
          await tx.update(spsPluginNodeRuns).set({ status: "failed", error: "SPS plugin execution access was revoked or changed before this run was claimed.", finishedAt: now, updatedAt: now }).where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued")));
          continue;
        }
        if (!await pluginRunRunnerCanStart(candidate)) {
          await tx.update(spsPluginNodeRuns).set({ status: "failed", error: "The selected SPS Node Runner Profile is unavailable, requires a local sign-in, or no longer supports direct execution.", finishedAt: now, updatedAt: now }).where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued")));
          continue;
        }
        const runner = await db.select({ kind: spsNodeRunnerProfiles.kind }).from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.id, candidate.runnerProfileId)).then(rows => rows[0] ?? null);
        const runtime = spsNodeExecutableRuntimeKindSchema.safeParse(runner?.kind);
        if (!runtime.success) {
          await tx.update(spsPluginNodeRuns).set({ status: "failed", error: "The selected SPS Node Runner Profile does not support direct SPS CLI execution.", finishedAt: now, updatedAt: now }).where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued")));
          continue;
        }
        const claimed = await tx.update(spsPluginNodeRuns).set({ status: "claimed", claimedAt: now, startedAt: now, updatedAt: now, timeoutMs })
          .where(and(eq(spsPluginNodeRuns.id, candidate.id), eq(spsPluginNodeRuns.status, "queued"))).returning().then(rows => rows[0] ?? null);
        if (claimed) return { status: 200, data: { ...claimed, runtimeKind: runtime.data } };
      }
      });
    }
    if (input.operation === "plugin-lease") {
      const run = await db.select().from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.id, input.resourceId!), eq(spsPluginNodeRuns.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!run) throw notFound("SPS plugin run not found");
      if (run.status !== "claimed" && run.status !== "running") return { status: 200, data: { active: false, status: run.status, error: run.error ?? null } };
      try { await assertSpsWorkspaceExecutionActive(db, node.companyId, run.workspaceExecutionEpoch); }
      catch { return { status: 200, data: { active: false, status: "cancelled", error: "Workspace execution was stopped" } }; }
      if (!await pluginRunHasCurrentAuthority(node, run)) {
        const reason = "SPS plugin execution access was revoked or changed while this run was active.";
        await failActivePluginRun({ runId: run.id, reason });
        return { status: 200, data: { active: false, status: "failed", error: reason } };
      }
      return { status: 200, data: { active: true, status: run.status, error: null } };
    }
    if (input.operation === "plugin-event") {
      const event = spsNodeCommandEventSchema.parse(body);
      const run = await db.select().from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.id, input.resourceId!), eq(spsPluginNodeRuns.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!run) throw notFound("SPS plugin run not found");
      await assertSpsWorkspaceExecutionActive(db, node.companyId, run.workspaceExecutionEpoch);
      if (run.status !== "claimed" && run.status !== "running") throw forbidden("SPS plugin run is not accepting output");
      if (!await pluginRunHasCurrentAuthority(node, run)) {
        const reason = "SPS plugin execution access was revoked or changed while this run was active.";
        await failActivePluginRun({ runId: run.id, reason });
        throw forbidden(reason);
      }
      if (event.sequence !== run.lastEventSeq + 1) throw badRequest("SPS plugin run output sequence is out of order");
      const now = new Date();
      await transaction(async tx => {
        await lockSpsWorkspaceExecutionControl(tx, node.companyId);
        await assertSpsWorkspaceExecutionActive(tx, node.companyId, run.workspaceExecutionEpoch);
        const accepted = await tx.update(spsPluginNodeRuns).set({ status: "running", lastEventSeq: event.sequence, updatedAt: now })
          .where(and(eq(spsPluginNodeRuns.id, run.id), inArray(spsPluginNodeRuns.status, ["claimed", "running"]), eq(spsPluginNodeRuns.lastEventSeq, event.sequence - 1)))
          .returning({ id: spsPluginNodeRuns.id });
        if (!accepted.length) throw forbidden("SPS plugin run no longer accepts this output");
        await tx.insert(spsPluginNodeRunEvents).values({ runId: run.id, sequence: event.sequence, stream: event.stream, body: event.body });
      });
      return { status: 204, data: null };
    }
    if (input.operation === "plugin-complete") {
      const parsed = spsPluginNodeRunCompleteSchema.safeParse(body);
      if (!parsed.success) throw badRequest("Invalid SPS plugin completion report");
      const completion = parsed.data;
      const run = await db.select().from(spsPluginNodeRuns).where(and(eq(spsPluginNodeRuns.id, input.resourceId!), eq(spsPluginNodeRuns.nodeId, node.id))).then(rows => rows[0] ?? null);
      if (!run) throw notFound("SPS plugin run not found");
      if (["succeeded", "failed", "cancelled"].includes(run.status)) return { status: 200, data: run };
      if (!["claimed", "running", "cancelling"].includes(run.status)) throw forbidden("SPS plugin run is not active");
      if (run.status !== "cancelling" && !await pluginRunHasCurrentAuthority(node, run)) {
        const reason = "SPS plugin execution access was revoked or changed while this run was active.";
        await failActivePluginRun({ runId: run.id, reason });
        const failed = await db.select().from(spsPluginNodeRuns).where(eq(spsPluginNodeRuns.id, run.id)).then(rows => rows[0]!);
        return { status: 200, data: failed };
      }
      let usageJson: Record<string, unknown> | null = null;
      if (completion.usageReport !== undefined) {
        try { usageJson = createSpsNodeUsageReceipt(run, completion.usageReport); }
        catch { throw badRequest("SPS usage report does not match this execution"); }
      }
      const updated = await transaction(async tx => {
        const control = await lockSpsWorkspaceExecutionControl(tx, node.companyId);
        const runEpoch = BigInt(run.workspaceExecutionEpoch ?? "0"), currentEpoch = BigInt(control.epoch);
        if (runEpoch > currentEpoch) throw forbidden("SPS plugin run generation is invalid");
        const cancellationRequested = run.status === "cancelling" || runEpoch < currentEpoch || control.state === "stopped";
        if (!cancellationRequested) await assertSpsWorkspaceExecutionActive(tx, node.companyId, run.workspaceExecutionEpoch);
        return tx.update(spsPluginNodeRuns).set({
          status: cancellationRequested ? "cancelled" : completion.status,
          exitCode: completion.exitCode, signal: completion.signal ?? null, timedOut: completion.timedOut ? 1 : 0,
          error: cancellationRequested ? run.error ?? "Workspace execution was stopped." : completion.error ?? null,
          usageJson, completionReceiptDigest: createSpsNodeCompletionReceiptDigest({ kind: "plugin-run", nodeId: run.nodeId,
            commandId: run.id, completion }), finishedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(spsPluginNodeRuns.id, run.id), eq(spsPluginNodeRuns.nodeId, node.id),
          inArray(spsPluginNodeRuns.status, ["claimed", "running", "cancelling"])))
          .returning().then(rows => rows[0] ?? null);
      });
      const current = updated ?? await db.select().from(spsPluginNodeRuns)
        .where(and(eq(spsPluginNodeRuns.id, run.id), eq(spsPluginNodeRuns.nodeId, node.id)))
        .then(rows => rows[0] ?? null);
      if (!current) throw notFound("SPS plugin run not found");
      return { status: 200, data: current };
    }
    throw badRequest("Unknown SPS Node operation");
  }

  return Object.freeze({ register, invoke });
}
