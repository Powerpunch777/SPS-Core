import type { InitializeParams, WorkerToHostMethodName } from "../compat/paperclip/plugin-sdk.js";

// Only the neutral public Runtime and Agent-session facade, never legacy secrets.
const PUBLIC_HOST_OPERATIONS = [
  "sps.executions.list", "sps.executions.get", "sps.executions.summarize",
  "sps.workspaceSources.list", "sps.runtimes.list", "sps.executionGrants.list",
  "sps.models.list", "sps.models.submit", "sps.models.get", "sps.models.cancel",
  "sps.executionGrants.upsert", "sps.executionGrants.revoke", "sps.runs.dispatch",
  "sps.runs.get", "sps.runs.list", "sps.runs.listEvents", "sps.runs.cancel",
  "sps.artifacts.publish", "sps.artifacts.list", "agents.list", "agents.describeExecution",
  "agents.sessions.create", "agents.sessions.list", "agents.sessions.sendMessage",
  "agents.sessions.getRun", "agents.sessions.cancel",
] as const satisfies readonly WorkerToHostMethodName[];

/** Registration only; live invocation, capability, resource and tenant checks remain mandatory. */
export function describeSpsHostSupport(
  handlers: Partial<Record<WorkerToHostMethodName, unknown>>,
): NonNullable<InitializeParams["spsHost"]> {
  const operations = PUBLIC_HOST_OPERATIONS.filter(operation => {
    const descriptor = Object.getOwnPropertyDescriptor(handlers, operation);
    return descriptor && "value" in descriptor && typeof descriptor.value === "function";
  }).sort();
  return { contractVersion: "1.0", operations };
}
