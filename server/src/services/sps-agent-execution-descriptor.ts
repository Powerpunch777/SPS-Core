import { and, eq } from "drizzle-orm";
import { agents, spsAgentNodeBindings, spsNodes, type Db } from "../compat/paperclip/db.js";
import type { PluginAgentExecutionDescriptor } from "../compat/paperclip/plugin-sdk.js";
import { describeSpsRuntimeConnection } from "./sps-runtime-connection.js";

/** Reads only routing/configuration evidence, never adapter config, credentials or live probes. */
export async function describeSpsAgentExecution(
  db: Db,
  input: { agentId: string; companyId: string },
  isAdapterRegistered: (adapterType: string) => boolean,
): Promise<PluginAgentExecutionDescriptor> {
  const [agent] = await db.select({ id: agents.id, status: agents.status, adapterType: agents.adapterType })
    .from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!agent) throw new Error("Agent not found in this Workspace");
  const [binding] = await db.select({ nodeId: spsAgentNodeBindings.nodeId }).from(spsAgentNodeBindings)
    .where(and(eq(spsAgentNodeBindings.agentId, agent.id), eq(spsAgentNodeBindings.companyId, input.companyId)));
  const adapterType = /^[a-z][a-z0-9_-]{0,79}$/.test(agent.adapterType) ? agent.adapterType : "unknown";
  const state = ["paused", "terminated", "pending_approval"].includes(agent.status) ? "disabled"
    : ["active", "idle", "running", "error"].includes(agent.status) ? "configured" : "unknown";
  const result: PluginAgentExecutionDescriptor = {
    agentId: agent.id, adapterType, state,
    adapterRegistration: adapterType !== "unknown" && isAdapterRegistered(adapterType) ? "registered" : "unavailable",
    executionOwner: binding ? "node" : "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null,
  };
  if (binding) {
    const [node] = await db.select({ id: spsNodes.id, status: spsNodes.status, keyVerifiedAt: spsNodes.keyVerifiedAt, lastSeenAt: spsNodes.lastSeenAt })
      .from(spsNodes).where(and(eq(spsNodes.id, binding.nodeId), eq(spsNodes.companyId, input.companyId)));
    const observation = node ? describeSpsRuntimeConnection(node) : null;
    result.node = { id: node?.id ?? null, state: observation?.state ?? "unknown", observedAt: observation?.observedAt ?? null };
  }
  return result;
}
