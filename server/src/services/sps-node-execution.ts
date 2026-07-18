import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  spsAgentNodeBindings,
  spsNodeAgentGrants,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodes,
} from "@paperclipai/db";
import { spsNodeCapabilityForAdapter, spsNodeSupportsAdapter } from "@paperclipai/shared";
import type { AdapterSpsNodeExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const NODE_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const COMMAND_RESULT_GRACE_MS = 90 * 1000;
const COMMAND_POLL_MS = 300;
const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
export class SpsNodeExecutionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpsNodeExecutionUnavailableError";
  }
}

function isNodeOnline(lastSeenAt: Date | null, now = Date.now()) {
  return lastSeenAt != null && now - lastSeenAt.getTime() <= NODE_ONLINE_WINDOW_MS;
}

export function isSpsNodeExecutionAdapterType(adapterType: string) {
  return spsNodeCapabilityForAdapter(adapterType) !== null;
}

function supportedByNode(adapterType: string, capabilities: Array<{ kind: string }>) {
  return spsNodeSupportsAdapter(capabilities, adapterType);
}

function appendExcerpt(current: string, chunk: string) {
  if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
  return `${current}${chunk}`.slice(-MAX_CAPTURED_OUTPUT_BYTES);
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

  const [node, grant] = await Promise.all([
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
  ]);

  if (!node || !grant || node.status !== "active" || !node.keyVerifiedAt) {
    throw new SpsNodeExecutionUnavailableError("The SPS Desktop Node binding is no longer approved for this Agent.");
  }
  if (!isNodeOnline(node.lastSeenAt)) {
    throw new SpsNodeExecutionUnavailableError(`SPS Desktop Node "${node.displayName}" is offline. Keep SPS Desktop open and connected before waking this Agent.`);
  }
  if (!supportedByNode(input.adapterType, node.capabilities)) {
    throw new SpsNodeExecutionUnavailableError(
      `SPS Desktop Node "${node.displayName}" does not advertise a runtime for adapter "${input.adapterType}".`,
    );
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
        const created = await input.db
          .insert(spsNodeCommands)
          .values({
            companyId: input.companyId,
            nodeId: node.id,
            agentId: input.agentId,
            heartbeatRunId: input.heartbeatRunId,
            projectId: input.projectId,
            command: commandInput.command,
            args: commandInput.args,
            cwdHint: commandInput.cwd,
            env: commandInput.env,
            stdin: commandInput.stdin ?? null,
            timeoutMs: commandInput.timeoutMs ?? null,
          })
          .returning()
          .then((rows) => rows[0]!);

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
          if (current.status === "succeeded" || current.status === "failed") {
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
