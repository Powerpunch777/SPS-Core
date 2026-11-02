import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { HostServices, WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { createSpsWorkspacePluginHostHandlers } from "../services/sps-workspace-plugin-host.js";
import { assertSpsWorkspaceAgentSessionInvocation } from "../services/sps-workspace-agent-session-invocation.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const manifest: PaperclipPluginManifestV1 = {
  id: "sps.workspace-agent-sessions-test", apiVersion: 1, version: "1.0.0",
  displayName: "Workspace Agent Sessions", description: "Fixture", author: "SPS",
  categories: ["automation"], capabilities: [],
  entrypoints: { worker: "./host-worker.js", workspaceWorker: "./workspace-worker.js" },
};

const methods = [
  ["agents.sessions.create", "create", { agentId: "agent-a", companyId: workspaceA }],
  ["agents.sessions.ensure", "ensure", { agentId: "agent-a", companyId: workspaceA, taskKey: "plugin:key" }],
  ["agents.sessions.list", "list", { agentId: "agent-a", companyId: workspaceA }],
  ["agents.sessions.sendMessage", "sendMessage", { sessionId: "session-a", companyId: workspaceA, prompt: "hello" }],
  ["agents.sessions.getRun", "getRun", { sessionId: "session-a", companyId: workspaceA, runId: "run-a" }],
  ["agents.sessions.getRequest", "getRequest", { sessionId: "session-a", companyId: workspaceA, requestId: "request-a" }],
  ["agents.sessions.cancel", "cancel", { sessionId: "session-a", companyId: workspaceA, runId: "run-a" }],
] as const;
const capabilityFor: Record<SessionMethod, string> = {
  "agents.sessions.create": "agent.sessions.create",
  "agents.sessions.ensure": "agent.sessions.create",
  "agents.sessions.list": "agent.sessions.list",
  "agents.sessions.sendMessage": "agent.sessions.send",
  "agents.sessions.getRun": "agent.sessions.read",
  "agents.sessions.getRequest": "agent.sessions.read",
  "agents.sessions.cancel": "agent.sessions.cancel",
};

type SessionMethod = typeof methods[number][0];

function workspaceContext(
  callback: () => Promise<void> = async () => {},
  scope = workspaceA,
): WorkerHostCallContext {
  return {
    invocationScope: { companyId: scope },
    assertCurrentInvocation: callback,
  };
}

function createSessionServices() {
  // This fake checks invocation scope only; it does not replace the scoped SQL ownership tests.
  const calls: Array<{ method: SessionMethod; params: unknown }> = [];
  const implementation = Object.fromEntries(methods.map(([method, serviceMethod]) => [
    serviceMethod,
    vi.fn(async (params: { companyId: string }) => {
      await assertSpsWorkspaceAgentSessionInvocation(pluginId, params.companyId);
      calls.push({ method, params });
      return { method, params };
    }),
  ])) as Record<string, ReturnType<typeof vi.fn>>;
  return {
    calls,
    services: { agentSessions: implementation } as unknown as HostServices,
    implementation,
  };
}

function createHandlers(capabilities: string[], services: HostServices) {
  return createSpsWorkspacePluginHostHandlers({
    workspaceId: workspaceA,
    pluginId,
    manifest: { ...manifest, capabilities },
    services,
    readConfig: async () => ({}),
  }) as Record<string, ((params: unknown, context?: WorkerHostCallContext) => Promise<unknown>) | undefined>;
}

describe("SPS Workspace Agent session handlers", () => {
  it.each(methods)("denies %s without its capability before service invocation", async (method, serviceMethod, params) => {
    const { services, implementation } = createSessionServices();
    const handlers = createHandlers([], services);

    await expect(handlers[method]!(params, workspaceContext())).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });
    expect(Object.values(implementation).every(service => service.mock.calls.length === 0)).toBe(true);
  });

  it.each(methods)("rejects untrusted, foreign, and invalid invocation scopes for %s", async (method, serviceMethod, params) => {
    const { services, implementation } = createSessionServices();
    const handlers = createHandlers([capabilityFor[method]], services);
    const callback = vi.fn(async () => {});
    const cases = [
      [params, undefined],
      [{ ...params, companyId: workspaceB }, workspaceContext(callback)],
      [params, workspaceContext(callback, workspaceB)],
      [params, { ...workspaceContext(callback), invalidInvocationScope: true }],
      [params, { invocationScope: { companyId: workspaceA } }],
      [params, { ...workspaceContext(), assertCurrentInvocation: undefined }],
      [params, { ...workspaceContext(), assertCurrentInvocation: "not-a-callback" }],
    ] as const;

    for (const [request, context] of cases) {
      await expect(handlers[method]!(request, context as WorkerHostCallContext)).rejects.toThrow();
    }
    expect(Object.values(implementation).every(service => service.mock.calls.length === 0)).toBe(true);
  });

  it.each(methods)("delegates %s only after current invocation validation", async (method, serviceMethod, params) => {
    const { services, implementation, calls } = createSessionServices();
    const handlers = createHandlers([capabilityFor[method]], services);
    const assertCurrentInvocation = vi.fn(async () => {});

    await expect(handlers[method]!(params, workspaceContext(assertCurrentInvocation))).resolves.toEqual({ method, params });
    expect(assertCurrentInvocation).toHaveBeenCalled();
    expect(calls).toEqual([{ method, params }]);
    expect(implementation[serviceMethod]).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("keeps each asynchronous service invocation isolated from the next call", async () => {
    const { services } = createSessionServices();
    const handlers = createHandlers([capabilityFor["agents.sessions.list"]], services);
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstChecked = vi.fn(async () => { await firstPaused; });
    const first = handlers["agents.sessions.list"]!({ agentId: "agent-a", companyId: workspaceA }, workspaceContext(firstChecked));

    await vi.waitFor(() => expect(firstChecked).toHaveBeenCalled());
    await expect(assertSpsWorkspaceAgentSessionInvocation(pluginId, workspaceA)).rejects.toThrow();
    releaseFirst();
    await expect(first).resolves.toMatchObject({ method: "agents.sessions.list" });
    await expect(assertSpsWorkspaceAgentSessionInvocation(pluginId, workspaceA)).rejects.toThrow();
  });

  it("binds the invocation assertion to both its exact plugin and Workspace", async () => {
    const { services } = createSessionServices();
    const handlers = createHandlers([capabilityFor["agents.sessions.list"]], services);
    const assertCurrentInvocation = vi.fn(async () => {
      await expect(assertSpsWorkspaceAgentSessionInvocation(pluginId, workspaceB)).rejects.toThrow();
      await expect(assertSpsWorkspaceAgentSessionInvocation("44444444-4444-4444-8444-444444444444", workspaceA)).rejects.toThrow();
    });

    await expect(handlers["agents.sessions.list"]!(
      { agentId: "agent-a", companyId: workspaceA },
      workspaceContext(assertCurrentInvocation),
    )).resolves.toMatchObject({ method: "agents.sessions.list" });
  });

  it("rejects an invocation revoked before delegation", async () => {
    const { services, implementation } = createSessionServices();
    const handlers = createHandlers(["agent.sessions.send"], services);
    const assertCurrentInvocation = vi.fn(async () => { throw new Error("invocation revoked"); });

    await expect(handlers["agents.sessions.sendMessage"]!(
      { sessionId: "session-a", companyId: workspaceA, prompt: "hello" },
      workspaceContext(assertCurrentInvocation),
    )).rejects.toThrow();
    expect(implementation.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects an invocation revoked while the delegated service is awaiting", async () => {
    let releaseService!: () => void;
    let serviceStarted!: () => void;
    const serviceGate = new Promise<void>(resolve => { releaseService = resolve; });
    const started = new Promise<void>(resolve => { serviceStarted = resolve; });
    const sendMessage = vi.fn(async (params: { companyId: string }) => {
      await assertSpsWorkspaceAgentSessionInvocation(pluginId, params.companyId);
      serviceStarted();
      await serviceGate;
      return { runId: "run-a" };
    });
    const services = { agentSessions: { sendMessage } } as unknown as HostServices;
    const handlers = createHandlers(["agent.sessions.send"], services);
    let active = true;
    const assertCurrentInvocation = vi.fn(async () => {
      if (!active) throw new Error("invocation revoked");
    });

    const result = handlers["agents.sessions.sendMessage"]!(
      { sessionId: "session-a", companyId: workspaceA, prompt: "hello" },
      workspaceContext(assertCurrentInvocation),
    );
    await started;
    active = false;
    releaseService();
    await expect(result).rejects.toThrow();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(assertCurrentInvocation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not expose close or global mutation handlers", async () => {
    const { services } = createSessionServices();
    const handlers = createHandlers(methods.map(([method]) => capabilityFor[method]), services);

    for (const unavailable of [
      "agents.sessions.close", "agents.pause", "agents.resume", "agents.invoke",
      "agents.managed.reconcile", "agents.managed.reset", "db.query", "db.execute",
    ]) {
      expect(Object.hasOwn(handlers, unavailable)).toBe(false);
    }
  });
});
