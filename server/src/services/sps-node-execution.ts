import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import {
  spsAgentNodeBindings,
  spsHostProjectShareNodeGrants,
  spsHostProjectShares,
  spsNodeAgentGrants,
  spsNodeAgentRunnerGrants,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodeRunnerProfiles,
  spsNodes,
  heartbeatRuns,
} from "../compat/paperclip/db.js";
import { spsNodeCapabilityForAdapter, spsNodeSupportsAdapter } from "../compat/paperclip/shared.js";
import type { AdapterSpsNodeExecutionTarget } from "../compat/paperclip/adapter-runtime.js";
import { hasSpsSessionCancellation } from "./sps-agent-session-runs.js";
import { isSpsNodeHeartbeatRecent } from "./sps-runtime-connection.js";
import { withSpsWorkspaceExecutionAdmission } from "./sps-workspace-execution-control.js";

const COMMAND_RESULT_GRACE_MS = 90 * 1000;
const COMMAND_POLL_MS = 300;
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
export class SpsNodeExecutionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpsNodeExecutionUnavailableError";
  }
}


export function isSpsNodeExecutionAdapterType(adapterType: string) {
  return spsNodeCapabilityForAdapter(adapterType) !== null;
}

function supportedByNode(adapterType: string, capabilities: Array<{ kind: string }>) {
  return spsNodeSupportsAdapter(capabilities, adapterType);
}

function runnerCanAcceptCommand(status: string, credentialStatus: string) {
  return credentialStatus !== "auth_required" && (status === "available" || status === "unknown");
}

function runnerUnavailableMessage(input: {
  nodeLabel: string;
  runnerLabel: string;
  status: string;
  retryAfter: Date | null;
}) {
  if (input.status === "quota_limited") {
    const retryHint = input.retryAfter ? ` Retry after ${input.retryAfter.toISOString()}.` : "";
    return `Runner \"${input.runnerLabel}\" on SPS Desktop Node \"${input.nodeLabel}\" is quota limited.${retryHint}`;
  }
  if (input.status === "auth_required") {
    return `Runner \"${input.runnerLabel}\" on SPS Desktop Node \"${input.nodeLabel}\" requires a local sign-in.`;
  }
  if (input.status === "busy") {
    return `Runner \"${input.runnerLabel}\" on SPS Desktop Node \"${input.nodeLabel}\" is busy.`;
  }
  if (input.status === "offline") {
    return `Runner \"${input.runnerLabel}\" on SPS Desktop Node \"${input.nodeLabel}\" is offline.`;
  }
  return `No available Runner Profile on SPS Desktop Node \"${input.nodeLabel}\" can execute this Agent.`;
}

function appendExcerpt(current: string, chunk: string) {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return `${current}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_BYTES);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type SpsHostProjectWorkspaceAccess = {
  kind: "sps_host_share";
  shareId: string;
  sharePath: string;
  credentialAlgorithm: "rsa-oaep-sha256" | "rsa-oaep-sha256+a256gcm";
  credentialEnvelope: string;
};

async function resolveProjectWorkspaceAccess(input: {
  db: Db;
  companyId: string;
  projectId: string | null;
  nodeId: string;
}): Promise<{ cwdHint: string | null; workspaceAccess: SpsHostProjectWorkspaceAccess | null }> {
  if (!input.projectId) return { cwdHint: null, workspaceAccess: null };
  const share = await input.db
    .select()
    .from(spsHostProjectShares)
    .where(and(
      eq(spsHostProjectShares.companyId, input.companyId),
      eq(spsHostProjectShares.projectId, input.projectId),
      eq(spsHostProjectShares.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);
  if (!share || (share.hostNodeId && share.hostNodeId === input.nodeId)) {
    return { cwdHint: null, workspaceAccess: null };
  }
  const grant = await input.db
    .select()
    .from(spsHostProjectShareNodeGrants)
    .where(and(
      eq(spsHostProjectShareNodeGrants.companyId, input.companyId),
      eq(spsHostProjectShareNodeGrants.shareId, share.id),
      eq(spsHostProjectShareNodeGrants.nodeId, input.nodeId),
      isNull(spsHostProjectShareNodeGrants.revokedAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (!grant) {
    throw new SpsNodeExecutionUnavailableError(
      "The Owner Host has not granted this SPS Node access to the project's source folder.",
    );
  }
  if (grant.credentialAlgorithm !== "rsa-oaep-sha256" && grant.credentialAlgorithm !== "rsa-oaep-sha256+a256gcm") {
    throw new SpsNodeExecutionUnavailableError("This SPS Host project share uses an unsupported Node credential envelope.");
  }
  return {
    cwdHint: share.sharePath,
    workspaceAccess: {
      kind: "sps_host_share",
      shareId: share.id,
      sharePath: share.sharePath,
      credentialAlgorithm: grant.credentialAlgorithm,
      credentialEnvelope: grant.credentialEnvelope,
    },
  };
}

export async function resolveSpsNodeExecutionTarget(input: {
  db: Db;
  companyId: string;
  agentId: string;
  adapterType: string;
  heartbeatRunId: string | null;
  projectId: string | null;
}): Promise<AdapterSpsNodeExecutionTarget | null> {
  const binding = await input.db
    .select()
    .from(spsAgentNodeBindings)
    .where(and(
      eq(spsAgentNodeBindings.companyId, input.companyId),
      eq(spsAgentNodeBindings.agentId, input.agentId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!binding) return null;

  const [node, grant, runnerProfiles, runnerGrants] = await Promise.all([
    input.db
      .select()
      .from(spsNodes)
      .where(and(eq(spsNodes.id, binding.nodeId), eq(spsNodes.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null),
    input.db
      .select()
      .from(spsNodeAgentGrants)
      .where(and(
        eq(spsNodeAgentGrants.companyId, input.companyId),
        eq(spsNodeAgentGrants.nodeId, binding.nodeId),
        eq(spsNodeAgentGrants.agentId, input.agentId),
        isNull(spsNodeAgentGrants.revokedAt),
      ))
      .then((rows) => rows[0] ?? null),
    input.db
      .select()
      .from(spsNodeRunnerProfiles)
      .where(and(
        eq(spsNodeRunnerProfiles.companyId, input.companyId),
        eq(spsNodeRunnerProfiles.nodeId, binding.nodeId),
      )),
    input.db
      .select({ runnerProfileId: spsNodeAgentRunnerGrants.runnerProfileId })
      .from(spsNodeAgentRunnerGrants)
      .where(and(
        eq(spsNodeAgentRunnerGrants.companyId, input.companyId),
        eq(spsNodeAgentRunnerGrants.nodeId, binding.nodeId),
        eq(spsNodeAgentRunnerGrants.agentId, input.agentId),
        isNull(spsNodeAgentRunnerGrants.revokedAt),
      )),
  ]);

  if (!node || !grant || node.status !== "active" || !node.keyVerifiedAt) {
    throw new SpsNodeExecutionUnavailableError("The SPS Desktop Node binding is no longer approved for this Agent.");
  }
  if (!isSpsNodeHeartbeatRecent(node.lastSeenAt)) {
    throw new SpsNodeExecutionUnavailableError(`SPS Desktop Node "${node.displayName}" is offline. Keep SPS Desktop open and connected before waking this Agent.`);
  }
  if (!supportedByNode(input.adapterType, node.capabilities)) {
    throw new SpsNodeExecutionUnavailableError(
      `SPS Desktop Node "${node.displayName}" does not advertise a runtime for adapter "${input.adapterType}".`,
    );
  }

  const requiredRunnerKind = spsNodeCapabilityForAdapter(input.adapterType);
  const compatibleProfiles = requiredRunnerKind
    ? runnerProfiles.filter((profile) => profile.kind === requiredRunnerKind)
    : [];
  const grantedRunnerIds = new Set(runnerGrants.map((grant) => grant.runnerProfileId));
  const permittedProfiles = compatibleProfiles.filter((profile) => grantedRunnerIds.has(profile.id));
  if (compatibleProfiles.length > 0 && permittedProfiles.length === 0) {
    throw new SpsNodeExecutionUnavailableError(
      `SPS Desktop Node "${node.displayName}" has no approved ${requiredRunnerKind} Runner Profile for this Agent. Grant a compatible Runner Profile before waking the Agent.`,
    );
  }
  const selectedRunner = permittedProfiles
    .filter((profile) => runnerCanAcceptCommand(profile.availabilityStatus, profile.credentialStatus))
    .sort((left, right) => {
      const leftRank = left.availabilityStatus === "available" ? 0 : 1;
      const rightRank = right.availabilityStatus === "available" ? 0 : 1;
      return leftRank - rightRank || left.createdAt.getTime() - right.createdAt.getTime();
    })[0] ?? null;
  if (compatibleProfiles.length > 0 && !selectedRunner) {
    const blockedRunner = permittedProfiles[0]!;
    throw new SpsNodeExecutionUnavailableError(runnerUnavailableMessage({
      nodeLabel: node.displayName,
      runnerLabel: blockedRunner.label,
      status: blockedRunner.credentialStatus === "auth_required" ? "auth_required" : blockedRunner.availabilityStatus,
      retryAfter: blockedRunner.retryAfter,
    }));
  }

  const remoteCwd = input.projectId
    ? `sps-project://${input.projectId}`
    : `sps-agent://${input.agentId}`;
  return {
    kind: "remote",
    transport: "sps_node",
    nodeId: node.id,
    nodeLabel: node.displayName,
    projectId: input.projectId,
    remoteCwd,
    runner: {
      execute: async (commandInput) => {
        const projectWorkspaceAccess = await resolveProjectWorkspaceAccess({
          db: input.db,
          companyId: input.companyId,
          projectId: input.projectId,
          nodeId: node.id,
        });
        const created = await withSpsWorkspaceExecutionAdmission(input.db, input.companyId, async (tx, workspaceExecutionEpoch) => {
          if (input.heartbeatRunId) {
            const parent = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.heartbeatRunId)).for("update").then(rows => rows[0]);
            if (!parent || !["queued", "running"].includes(parent.status) || hasSpsSessionCancellation(parent)
              || parent.workspaceExecutionEpoch !== workspaceExecutionEpoch) throw new Error("Session run is no longer accepting remote dispatch");
          }
          return tx
          .insert(spsNodeCommands)
          .values({
            companyId: input.companyId,
            workspaceExecutionEpoch,
            nodeId: node.id,
            agentId: input.agentId,
            runnerProfileId: selectedRunner?.id ?? null,
            heartbeatRunId: input.heartbeatRunId,
            projectId: input.projectId,
            command: commandInput.command,
            args: commandInput.args,
            cwdHint: projectWorkspaceAccess.cwdHint ?? commandInput.cwd,
            workspaceAccess: projectWorkspaceAccess.workspaceAccess,
            env: commandInput.env,
            stdin: commandInput.stdin ?? null,
            timeoutMs: commandInput.timeoutMs ?? null,
          })
          .returning()
          .then((rows) => rows[0]!);
        });

        let latestSequence = 0;
        let stdout = "";
        let stderr = "";
        const startedAt = new Date().toISOString();
        const effectiveTimeoutMs =
          typeof commandInput.timeoutMs === "number" && commandInput.timeoutMs > 0
            ? commandInput.timeoutMs
            : 4 * 60 * 60 * 1000;
        const deadline = Date.now() + effectiveTimeoutMs + COMMAND_RESULT_GRACE_MS;
        while (Date.now() <= deadline) {
          const [events, current] = await Promise.all([
            input.db
              .select()
              .from(spsNodeCommandEvents)
              .where(and(
                eq(spsNodeCommandEvents.commandId, created.id),
                gt(spsNodeCommandEvents.sequence, latestSequence),
              ))
              .orderBy(asc(spsNodeCommandEvents.sequence)),
            input.db
              .select()
              .from(spsNodeCommands)
              .where(eq(spsNodeCommands.id, created.id))
              .then((rows) => rows[0] ?? null),
          ]);
          for (const event of events) {
            latestSequence = event.sequence;
            if (event.stream === "stdout") stdout = appendExcerpt(stdout, event.body);
            else stderr = appendExcerpt(stderr, event.body);
            await commandInput.onLog?.(event.stream === "stdout" ? "stdout" : "stderr", event.body);
          }
          if (!current) {
            throw new Error("SPS Node command disappeared before it reported a result.");
          }
          if (current.status === "failed" || current.status === "cancelled") {
            const detail = current.error?.trim() || "SPS Desktop Node command failed without an error detail.";
            await commandInput.onLog?.("stderr", `${detail}\n`);
            throw new Error(detail);
          }
          if (current.status === "succeeded") {
            return {
              exitCode: current.exitCode,
              signal: current.signal,
              timedOut: current.timedOut !== 0,
              stdout,
              stderr: current.error ? appendExcerpt(stderr, `${current.error}\n`) : stderr,
              pid: null,
              startedAt,
            };
          }
          await sleep(COMMAND_POLL_MS);
        }
        throw new Error(`SPS Desktop Node "${node.displayName}" did not report command completion before the Hub deadline.`);
      },
    },
  };
}
