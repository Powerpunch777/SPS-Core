import { and, desc, eq, gt, isNull, lt, inArray } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import {
  spsNodes,
  spsNodeRunnerProfiles,
  spsPluginExecutionGrants,
  spsPluginArtifacts,
  spsPluginNodeRunEvents,
  spsPluginNodeRuns,
  spsWorkspaceSources,
} from "../compat/paperclip/db.js";
import { spsNodeExecutableRuntimeKindSchema } from "../compat/paperclip/shared.js";
import { normalizeSpsPluginExecutionTimeout } from "./sps-execution-timeout.js";

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const RUNNER_COMMAND_BY_KIND = {
  claude_cli: "claude",
  codex_cli: "codex",
  agy_cli: "agy",
  gemini_cli: "gemini",
  opencode_cli: "opencode",
  pi_cli: "pi",
  ollama: "ollama",
  lm_studio: "lms",
} as const;

type ExecutableRuntimeKind = keyof typeof RUNNER_COMMAND_BY_KIND;

function isNodeOnline(lastSeenAt: Date | null, now = Date.now()) {
  return lastSeenAt != null && now - lastSeenAt.getTime() <= ONLINE_WINDOW_MS;
}

function requiredString(value: string, field: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must be a non-empty value no longer than ${maxLength} characters`);
  }
  return normalized;
}

function normalizeArgs(args: string[]) {
  if (!Array.isArray(args) || args.length > 256) throw new Error("args must contain at most 256 values");
  return args.map((value) => requiredString(String(value), "args entries", 16_000));
}

function normalizeEnvironment(env: Record<string, string> | undefined) {
  if (!env) return {};
  const entries = Object.entries(env);
  if (entries.length > 64) throw new Error("env may contain at most 64 values");
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
      throw new Error("env keys must use uppercase letters, numbers, and underscores");
    }
    output[key] = requiredString(String(value), `env.${key}`, 16_000);
  }
  return output;
}

function publicSource(source: typeof spsWorkspaceSources.$inferSelect) {
  return {
    id: source.id,
    displayName: source.displayName,
    status: source.status,
    routeStatus: source.sharePath ? "configured" as const : "not_configured" as const,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function publicRunner(input: {
  node: typeof spsNodes.$inferSelect;
  runner: typeof spsNodeRunnerProfiles.$inferSelect;
}) {
  return {
    id: input.runner.id,
    nodeId: input.node.id,
    nodeLabel: input.node.displayName,
    kind: input.runner.kind,
    runnerKey: input.runner.runnerKey,
    label: input.runner.label,
    profileLabel: input.runner.profileLabel,
    credentialStatus: input.runner.credentialStatus,
    availabilityStatus: input.runner.availabilityStatus,
    availabilityDetail: input.runner.availabilityDetail,
    availabilityObservedAt: input.runner.availabilityObservedAt?.toISOString() ?? null,
    retryAfter: input.runner.retryAfter?.toISOString() ?? null,
    online: isNodeOnline(input.node.lastSeenAt),
  };
}

function publicGrant(grant: typeof spsPluginExecutionGrants.$inferSelect) {
  return {
    id: grant.id,
    companyId: grant.companyId,
    pluginKey: grant.pluginKey,
    subjectKey: grant.subjectKey,
    nodeId: grant.nodeId,
    runnerProfileId: grant.runnerProfileId,
    workspaceSourceId: grant.workspaceSourceId,
    status: grant.status,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

function publicRun(run: typeof spsPluginNodeRuns.$inferSelect) {
  return {
    id: run.id,
    companyId: run.companyId,
    pluginKey: run.pluginKey,
    subjectKey: run.subjectKey,
    executionGrantId: run.executionGrantId,
    nodeId: run.nodeId,
    runnerProfileId: run.runnerProfileId,
    workspaceSourceId: run.workspaceSourceId,
    status: run.status,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut !== 0,
    error: run.error,
    claimedAt: run.claimedAt?.toISOString() ?? null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function publicArtifact(artifact: typeof spsPluginArtifacts.$inferSelect) {
  return {
    id: artifact.id,
    companyId: artifact.companyId,
    pluginKey: artifact.pluginKey,
    subjectKey: artifact.subjectKey,
    runId: artifact.runId,
    title: artifact.title,
    kind: artifact.kind,
    referenceUrl: artifact.referenceUrl,
    summary: artifact.summary,
    data: artifact.data,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
  };
}

function normalizeArtifactReferenceUrl(value: string | null | undefined) {
  const normalized = value?.trim() || null;
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("artifact referenceUrl must be an absolute https URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("artifact referenceUrl must use https");
  }
  if (normalized.length > 4_000) throw new Error("artifact referenceUrl must not exceed 4000 characters");
  return normalized;
}

function normalizeArtifactData(value: Record<string, unknown> | undefined) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact data must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("artifact data must be JSON serializable");
  }
  if (serialized.length > 100_000) throw new Error("artifact data must not exceed 100000 characters");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function runnerCanAcceptRun(runner: typeof spsNodeRunnerProfiles.$inferSelect) {
  return runner.credentialStatus !== "auth_required"
    && (runner.availabilityStatus === "available" || runner.availabilityStatus === "unknown");
}

/**
 * SPS Core's workflow-neutral plugin execution bridge. A plugin decides the
 * semantics of a subject and any human approval policy; Core owns only the
 * technical integrity of Nodes, local Runner Profiles, Host Sources, queued
 * process runs, and their output stream.
 */
export function spsPluginExecutionService(db: Db, pluginKey: string) {
  const normalizedPluginKey = requiredString(pluginKey, "pluginKey", 200);

  async function resolveTarget(input: {
    companyId: string;
    nodeId: string;
    runnerProfileId: string;
    workspaceSourceId?: string | null;
    requireRunnable?: boolean;
  }) {
    const [node, runner, source] = await Promise.all([
      db
        .select()
        .from(spsNodes)
        .where(and(eq(spsNodes.id, input.nodeId), eq(spsNodes.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(spsNodeRunnerProfiles)
        .where(and(
          eq(spsNodeRunnerProfiles.id, input.runnerProfileId),
          eq(spsNodeRunnerProfiles.companyId, input.companyId),
          eq(spsNodeRunnerProfiles.nodeId, input.nodeId),
        ))
        .then((rows) => rows[0] ?? null),
      input.workspaceSourceId
        ? db
          .select()
          .from(spsWorkspaceSources)
          .where(and(
            eq(spsWorkspaceSources.id, input.workspaceSourceId),
            eq(spsWorkspaceSources.companyId, input.companyId),
            eq(spsWorkspaceSources.status, "active"),
          ))
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    if (!node || node.status !== "active" || !node.keyVerifiedAt) {
      throw new Error("The selected SPS Node is not approved");
    }
    if (!runner) throw new Error("The selected SPS Node Runner Profile was not found on this Node");
    const runtime = spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind);
    if (!runtime.success) throw new Error("The selected SPS Node Runner Profile does not support direct CLI execution");
    if (input.workspaceSourceId && !source) {
      throw new Error("The selected SPS Workspace Source is not active in this company");
    }
    if (input.requireRunnable) {
      if (!isNodeOnline(node.lastSeenAt)) throw new Error(`SPS Node \"${node.displayName}\" is offline`);
      if (!runnerCanAcceptRun(runner)) {
        throw new Error(`SPS Node Runner Profile \"${runner.label}\" is not ready to execute`);
      }
    }
    return { node, runner, source, runtimeKind: runtime.data as ExecutableRuntimeKind };
  }

  return {
    async listWorkspaceSources(companyId: string) {
      const sources = await db
        .select()
        .from(spsWorkspaceSources)
        .where(eq(spsWorkspaceSources.companyId, companyId))
        .orderBy(spsWorkspaceSources.displayName);
      return sources.map(publicSource);
    },

    async listRuntimes(input: { companyId: string; nodeId?: string | null }) {
      const rows = await db
        .select({ node: spsNodes, runner: spsNodeRunnerProfiles })
        .from(spsNodeRunnerProfiles)
        .innerJoin(spsNodes, eq(spsNodes.id, spsNodeRunnerProfiles.nodeId))
        .where(and(
          eq(spsNodeRunnerProfiles.companyId, input.companyId),
          input.nodeId ? eq(spsNodeRunnerProfiles.nodeId, input.nodeId) : undefined,
        ))
        .orderBy(spsNodes.displayName, spsNodeRunnerProfiles.label);
      return rows
        .filter(({ runner }) => spsNodeExecutableRuntimeKindSchema.safeParse(runner.kind).success)
        .map(publicRunner);
    },

    async listExecutionGrants(input: { companyId: string; subjectKey?: string | null; includeRevoked?: boolean }) {
      const rows = await db
        .select()
        .from(spsPluginExecutionGrants)
        .where(and(
          eq(spsPluginExecutionGrants.companyId, input.companyId),
          eq(spsPluginExecutionGrants.pluginKey, normalizedPluginKey),
          input.subjectKey ? eq(spsPluginExecutionGrants.subjectKey, requiredString(input.subjectKey, "subjectKey", 240)) : undefined,
          input.includeRevoked ? undefined : isNull(spsPluginExecutionGrants.revokedAt),
        ))
        .orderBy(desc(spsPluginExecutionGrants.updatedAt));
      return rows.map(publicGrant);
    },

    async upsertExecutionGrant(input: {
      companyId: string;
      subjectKey: string;
      nodeId: string;
      runnerProfileId: string;
      workspaceSourceId?: string | null;
    }) {
      const subjectKey = requiredString(input.subjectKey, "subjectKey", 240);
      const workspaceSourceId = input.workspaceSourceId?.trim() || null;
      await resolveTarget({
        companyId: input.companyId,
        nodeId: input.nodeId,
        runnerProfileId: input.runnerProfileId,
        workspaceSourceId,
      });
      const existing = await db
        .select()
        .from(spsPluginExecutionGrants)
        .where(and(
          eq(spsPluginExecutionGrants.companyId, input.companyId),
          eq(spsPluginExecutionGrants.pluginKey, normalizedPluginKey),
          eq(spsPluginExecutionGrants.subjectKey, subjectKey),
          eq(spsPluginExecutionGrants.nodeId, input.nodeId),
          eq(spsPluginExecutionGrants.runnerProfileId, input.runnerProfileId),
        ))
        .then((rows) => rows.find((grant) => (grant.workspaceSourceId ?? null) === workspaceSourceId) ?? null);
      const now = new Date();
      if (existing) {
        const updated = await db
          .update(spsPluginExecutionGrants)
          .set({ status: "active", revokedAt: null, updatedAt: now })
          .where(eq(spsPluginExecutionGrants.id, existing.id))
          .returning()
          .then((rows) => rows[0]!);
        return publicGrant(updated);
      }
      const created = await db
        .insert(spsPluginExecutionGrants)
        .values({
          companyId: input.companyId,
          pluginKey: normalizedPluginKey,
          subjectKey,
          nodeId: input.nodeId,
          runnerProfileId: input.runnerProfileId,
          workspaceSourceId,
        })
        .returning()
        .then((rows) => rows[0]!);
      return publicGrant(created);
    },

    async revokeExecutionGrant(input: { companyId: string; grantId: string }) {
      const now = new Date();
      const grant = await db
        .update(spsPluginExecutionGrants)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(and(
          eq(spsPluginExecutionGrants.id, input.grantId),
          eq(spsPluginExecutionGrants.companyId, input.companyId),
          eq(spsPluginExecutionGrants.pluginKey, normalizedPluginKey),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!grant) throw new Error("SPS plugin execution grant was not found");
      await db
        .update(spsPluginNodeRuns)
        .set({
          status: "failed",
          error: "SPS plugin execution access was revoked.",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(spsPluginNodeRuns.executionGrantId, grant.id),
          eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey),
          eq(spsPluginNodeRuns.companyId, input.companyId),
          isNull(spsPluginNodeRuns.finishedAt),
        ));
      return publicGrant(grant);
    },

    async dispatchRun(input: {
      companyId: string;
      executionGrantId: string;
      args: string[];
      env?: Record<string, string>;
      stdin?: string | null;
      timeoutMs?: number | null;
    }) {
      const grant = await db
        .select()
        .from(spsPluginExecutionGrants)
        .where(and(
          eq(spsPluginExecutionGrants.id, input.executionGrantId),
          eq(spsPluginExecutionGrants.companyId, input.companyId),
          eq(spsPluginExecutionGrants.pluginKey, normalizedPluginKey),
          eq(spsPluginExecutionGrants.status, "active"),
          isNull(spsPluginExecutionGrants.revokedAt),
        ))
        .then((rows) => rows[0] ?? null);
      if (!grant) throw new Error("SPS plugin execution grant is not active");
      const target = await resolveTarget({
        companyId: input.companyId,
        nodeId: grant.nodeId,
        runnerProfileId: grant.runnerProfileId,
        workspaceSourceId: grant.workspaceSourceId,
        requireRunnable: true,
      });
      const timeoutMs = normalizeSpsPluginExecutionTimeout(input.timeoutMs);
      const stdin = input.stdin == null ? null : String(input.stdin);
      if (stdin !== null && stdin.length > 1_000_000) throw new Error("stdin must not exceed 1,000,000 characters");
      const run = await db
        .insert(spsPluginNodeRuns)
        .values({
          companyId: input.companyId,
          pluginKey: normalizedPluginKey,
          subjectKey: grant.subjectKey,
          executionGrantId: grant.id,
          nodeId: grant.nodeId,
          runnerProfileId: grant.runnerProfileId,
          workspaceSourceId: grant.workspaceSourceId,
          command: RUNNER_COMMAND_BY_KIND[target.runtimeKind],
          args: normalizeArgs(input.args),
          cwdHint: target.source?.sharePath ?? null,
          env: normalizeEnvironment(input.env),
          stdin,
          timeoutMs,
        })
        .returning()
        .then((rows) => rows[0]!);
      return publicRun(run);
    },

    async listRuns(input: { companyId: string; subjectKey?: string | null; status?: string | null; limit?: number | null; beforeId?: string | null }) {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200");
      const statuses = ["queued", "claimed", "running", "cancelling", "cancelled", "succeeded", "failed"];
      if (input.status != null && !statuses.includes(input.status)) throw new Error("Unknown SPS run status");
      if (input.beforeId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.beforeId)) throw new Error("beforeId must be a run UUID");
      const rows = await db.select().from(spsPluginNodeRuns).where(and(
        eq(spsPluginNodeRuns.companyId, input.companyId),
        eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey),
        input.subjectKey != null ? eq(spsPluginNodeRuns.subjectKey, requiredString(input.subjectKey, "subjectKey", 240)) : undefined,
        input.status != null ? eq(spsPluginNodeRuns.status, input.status) : undefined,
        input.beforeId != null ? lt(spsPluginNodeRuns.id, input.beforeId) : undefined,
      )).orderBy(desc(spsPluginNodeRuns.id)).limit(limit);
      return rows.map(publicRun);
    },

    async cancelRun(input: { companyId: string; runId: string }) {
      const scope = and(eq(spsPluginNodeRuns.id, input.runId), eq(spsPluginNodeRuns.companyId, input.companyId),
        eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey));
      // CAS updates prevent a queued cancellation from racing a successful claim.
      const now = new Date();
      await db.update(spsPluginNodeRuns).set({ status: "cancelled", error: "Cancelled before dispatch.", finishedAt: now, updatedAt: now })
        .where(and(scope, eq(spsPluginNodeRuns.status, "queued")));
      await db.update(spsPluginNodeRuns).set({ status: "cancelling", error: "Cancellation requested by the owning plugin.", updatedAt: now })
        .where(and(scope, inArray(spsPluginNodeRuns.status, ["claimed", "running"])));
      const run = await db.select().from(spsPluginNodeRuns).where(scope).then(rows => rows[0] ?? null);
      if (!run) throw new Error("SPS plugin run was not found");
      return publicRun(run);
    },

    async getRun(input: { companyId: string; runId: string }) {
      const run = await db
        .select()
        .from(spsPluginNodeRuns)
        .where(and(
          eq(spsPluginNodeRuns.id, input.runId),
          eq(spsPluginNodeRuns.companyId, input.companyId),
          eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (!run) throw new Error("SPS plugin run was not found");
      return publicRun(run);
    },

    async listRunEvents(input: { companyId: string; runId: string; afterSequence?: number | null }) {
      const run = await db
        .select({ id: spsPluginNodeRuns.id })
        .from(spsPluginNodeRuns)
        .where(and(
          eq(spsPluginNodeRuns.id, input.runId),
          eq(spsPluginNodeRuns.companyId, input.companyId),
          eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (!run) throw new Error("SPS plugin run was not found");
      const afterSequence = Math.max(0, Math.floor(input.afterSequence ?? 0));
      const events = await db
        .select()
        .from(spsPluginNodeRunEvents)
        .where(and(
          eq(spsPluginNodeRunEvents.runId, run.id),
          gt(spsPluginNodeRunEvents.sequence, afterSequence),
        ))
        .orderBy(spsPluginNodeRunEvents.sequence);
      return events.map((event) => ({
        sequence: event.sequence,
        stream: event.stream,
        body: event.body,
        createdAt: event.createdAt.toISOString(),
      }));
    },

    async publishArtifact(input: {
      companyId: string;
      subjectKey: string;
      runId?: string | null;
      title: string;
      kind?: string | null;
      referenceUrl?: string | null;
      summary?: string | null;
      data?: Record<string, unknown>;
    }) {
      const subjectKey = requiredString(input.subjectKey, "subjectKey", 240);
      const title = requiredString(input.title, "artifact title", 500);
      const kind = input.kind?.trim() || "reference";
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(kind)) {
        throw new Error("artifact kind must use letters, numbers, dots, underscores, or hyphens");
      }
      const summary = input.summary == null ? null : String(input.summary).trim() || null;
      if (summary && summary.length > 100_000) throw new Error("artifact summary must not exceed 100000 characters");
      const runId = input.runId?.trim() || null;
      if (runId) {
        const run = await db
          .select({ id: spsPluginNodeRuns.id })
          .from(spsPluginNodeRuns)
          .where(and(
            eq(spsPluginNodeRuns.id, runId),
            eq(spsPluginNodeRuns.companyId, input.companyId),
            eq(spsPluginNodeRuns.pluginKey, normalizedPluginKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (!run) throw new Error("SPS plugin run was not found for this artifact");
      }
      const artifact = await db
        .insert(spsPluginArtifacts)
        .values({
          companyId: input.companyId,
          pluginKey: normalizedPluginKey,
          subjectKey,
          runId,
          title,
          kind,
          referenceUrl: normalizeArtifactReferenceUrl(input.referenceUrl),
          summary,
          data: normalizeArtifactData(input.data),
        })
        .returning()
        .then((rows) => rows[0]!);
      return publicArtifact(artifact);
    },

    async listArtifacts(input: { companyId: string; subjectKey?: string | null; runId?: string | null; limit?: number | null }) {
      const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 200));
      const rows = await db
        .select()
        .from(spsPluginArtifacts)
        .where(and(
          eq(spsPluginArtifacts.companyId, input.companyId),
          eq(spsPluginArtifacts.pluginKey, normalizedPluginKey),
          input.subjectKey ? eq(spsPluginArtifacts.subjectKey, requiredString(input.subjectKey, "subjectKey", 240)) : undefined,
          input.runId ? eq(spsPluginArtifacts.runId, input.runId) : undefined,
        ))
        .orderBy(desc(spsPluginArtifacts.createdAt))
        .limit(limit);
      return rows.map(publicArtifact);
    },
  };
}
