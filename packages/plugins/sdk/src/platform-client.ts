import {
  AGENT_PLATFORM_CONTRACT_VERSION,
  normalizeAgentPlatformScope,
  type AgentPlatformBackend,
  type AgentPlatformRun,
  type AgentPlatformScope,
  type AgentPlatformThread,
} from "@paperclipai/shared";
import type {
  AgentSession,
  PluginAgentsClient,
  PluginPlatformClient,
  PluginStateClient,
} from "./types.js";

type PlatformClientDependencies = {
  agents: Pick<PluginAgentsClient, "get" | "sessions">;
  state: PluginStateClient;
};

function scopeForSession(session: AgentSession, organizationId: string): AgentPlatformScope {
  return normalizeAgentPlatformScope({
    organizationId,
    projectId: session.context?.projectId ?? null,
    workItemId: session.context?.issueId ?? null,
    threadId: session.sessionId,
    agentId: session.agentId,
  });
}

function toThread(session: AgentSession, organizationId: string): AgentPlatformThread {
  return {
    id: session.sessionId,
    scope: scopeForSession(session, organizationId),
    agentId: session.agentId,
    status: session.status === "closed" ? "closed" : "active",
    backendId: null,
    lastRunId: session.lastRunId,
    lastError: session.lastError,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
  };
}

function platformScopeToStateScope(scope: AgentPlatformScope): {
  scopeKind: "company" | "project" | "agent" | "issue" | "thread";
  scopeId: string;
} {
  const normalized = normalizeAgentPlatformScope(scope);
  if (normalized.threadId) return { scopeKind: "thread", scopeId: normalized.threadId };
  if (normalized.workItemId) return { scopeKind: "issue", scopeId: normalized.workItemId };
  if (normalized.agentId) return { scopeKind: "agent", scopeId: normalized.agentId };
  if (normalized.projectId) return { scopeKind: "project", scopeId: normalized.projectId };
  return { scopeKind: "company", scopeId: normalized.organizationId };
}

/**
 * Builds the additive neutral facade entirely from existing Core host clients.
 * This keeps Phase B data-compatible while we validate real workplanes before
 * introducing native Thread and Store registry tables.
 */
export function createPluginPlatformClient(deps: PlatformClientDependencies): PluginPlatformClient {
  return {
    contractVersion: AGENT_PLATFORM_CONTRACT_VERSION,
    threads: {
      async create(input) {
        const scope = normalizeAgentPlatformScope(input.scope);
        const session = await deps.agents.sessions.create(input.agentId, scope.organizationId, {
          taskKey: input.threadKey ? `platform:${input.threadKey}` : undefined,
          reason: input.reason,
          context: {
            ...(scope.projectId ? { projectId: scope.projectId } : {}),
            ...(scope.workItemId ? { issueId: scope.workItemId } : {}),
          },
        });
        return toThread(session, scope.organizationId);
      },

      async list(input) {
        const sessions = await deps.agents.sessions.list(input.agentId, input.organizationId);
        return sessions.map((session) => toThread(session, input.organizationId));
      },

      async send(input) {
        const result = await deps.agents.sessions.sendMessage(input.threadId, input.organizationId, {
          prompt: input.prompt,
          reason: input.reason,
          onEvent: input.onEvent,
        });
        const now = new Date().toISOString();
        return {
          id: result.runId,
          scope: normalizeAgentPlatformScope({
            organizationId: input.organizationId,
            threadId: input.threadId,
          }),
          threadId: input.threadId,
          agentId: "unknown",
          backendId: null,
          status: "queued",
          startedAt: null,
          finishedAt: null,
          error: null,
          createdAt: now,
        } satisfies AgentPlatformRun;
      },

      async close(input) {
        await deps.agents.sessions.close(input.threadId, input.organizationId);
      },
    },

    stores: {
      async getState(input) {
        const target = platformScopeToStateScope(input.scope);
        return deps.state.get({ ...target, stateKey: input.stateKey, namespace: input.namespace });
      },

      async setState(input, value) {
        const target = platformScopeToStateScope(input.scope);
        await deps.state.set({ ...target, stateKey: input.stateKey, namespace: input.namespace }, value);
      },

      async deleteState(input) {
        const target = platformScopeToStateScope(input.scope);
        await deps.state.delete({ ...target, stateKey: input.stateKey, namespace: input.namespace });
      },
    },

    backends: {
      async describeAgent(input) {
        const agent = await deps.agents.get(input.agentId, input.organizationId);
        if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
        return {
          id: `agent:${agent.id}:adapter`,
          organizationId: input.organizationId,
          kind: "adapter",
          displayName: agent.adapterType,
          status: agent.status === "terminated" ? "disabled" : "configured",
          capabilities: ["agent.run"],
        } satisfies AgentPlatformBackend;
      },
    },
  };
}
