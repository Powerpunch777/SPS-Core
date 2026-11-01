import { AsyncLocalStorage } from "node:async_hooks";

type Invocation = {
  workspaceId: string;
  pluginId: string;
  assertCurrent: () => void | Promise<void>;
  active: boolean;
};
const calls = new AsyncLocalStorage<Invocation>();
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const denied = () => new Error("Workspace Agent Session invocation is unavailable or expired.");

async function check(call: Invocation) {
  if (!call.active) throw denied();
  if (await call.assertCurrent() !== undefined || !call.active) throw denied();
}

/** Host-only dynamic scope. Never serialize this authority or retain it after RPC. */
export async function withSpsWorkspaceAgentSessionInvocation<T>(input: {
  workspaceId: string;
  pluginId: string;
  assertCurrent: () => void | Promise<void>;
}, action: () => Promise<T>): Promise<T> {
  if (!input || typeof input.workspaceId !== "string" || !uuid.test(input.workspaceId)
    || typeof input.pluginId !== "string" || !uuid.test(input.pluginId)
    || typeof input.assertCurrent !== "function" || typeof action !== "function") throw denied();
  const call: Invocation = { ...input, active: true };
  return calls.run(call, async () => {
    try {
      await check(call);
      const result = await action();
      await check(call);
      return result;
    } finally { call.active = false; }
  });
}

export async function assertSpsWorkspaceAgentSessionInvocation(pluginId: string, workspaceId: string): Promise<void> {
  const call = calls.getStore();
  if (!call || call.pluginId !== pluginId || call.workspaceId !== workspaceId) throw denied();
  await check(call);
}
