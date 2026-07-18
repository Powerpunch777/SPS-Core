export type WorkplaneAgentKind = "lead" | "worker" | "hybrid";

type AgentWithAdapterConfig = {
  adapterConfig?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Optional Workplane policy contract. It stays inert for ordinary Paperclip
 * Agents and activates only when an Agent has this explicit configuration.
 */
export function configuredWorkplaneAgentKind(agent: AgentWithAdapterConfig): WorkplaneAgentKind | null {
  const adapterConfig = asRecord(agent.adapterConfig);
  const workplane = asRecord(adapterConfig?.workplane);
  const kind = workplane?.kind;
  return kind === "lead" || kind === "worker" || kind === "hybrid" ? kind : null;
}

export function configuredWorkplaneWorker(agent: AgentWithAdapterConfig): boolean {
  return configuredWorkplaneAgentKind(agent) === "worker";
}
