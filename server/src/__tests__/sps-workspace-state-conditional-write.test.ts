import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { HostServices, WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { createSpsWorkspacePluginHostHandlers } from "../services/sps-workspace-plugin-host.js";

const workspaceId = "a1111111-a111-4111-8111-11111111111a";
const foreignWorkspaceId = "b2222222-b222-4222-8222-22222222222b";
const pluginId = "33333333-3333-4333-8333-333333333333";
const manifest: PaperclipPluginManifestV1 = {
  id: "sps.workspace-state-conditional-write-test", apiVersion: 1, version: "1.0.0",
  displayName: "Workspace State Conditional Write", description: "Fixture", author: "SPS",
  categories: ["automation"], capabilities: [],
  entrypoints: { worker: "./host-worker.js", workspaceWorker: "./workspace-worker.js" },
};

const params = {
  scopeKind: "company",
  scopeId: workspaceId,
  namespace: "fixture",
  stateKey: "revision",
  value: { revision: 2 },
  expected: { exists: true, value: { revision: 1 } },
};

function workspaceContext(assertCurrentInvocation?: () => Promise<void>, scopeId = workspaceId): WorkerHostCallContext {
  return {
    invocationScope: { companyId: scopeId },
    ...(assertCurrentInvocation ? { assertCurrentInvocation } : {}),
  };
}

function createStateServices(compareAndSet?: (...args: any[]) => Promise<unknown>) {
  const state = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    compareAndSet,
    delete: vi.fn(async () => {}),
  };
  return { services: { state } as unknown as HostServices, state };
}

function createHandlers(capabilities: string[], services: HostServices) {
  return createSpsWorkspacePluginHostHandlers({
    workspaceId,
    pluginId,
    manifest: { ...manifest, capabilities },
    services,
    readConfig: async () => ({}),
  }) as Record<string, ((params: unknown, context?: WorkerHostCallContext) => Promise<unknown>) | undefined>;
}

describe("SPS Workspace conditional state writes", () => {
  it.each([
    ["plugin.state.write", ["plugin.state.read"]],
    ["plugin.state.read", ["plugin.state.write"]],
  ] as const)("requires %s before delegating", async (_missingCapability, capabilities) => {
    const compareAndSet = vi.fn(async () => ({ swapped: true }));
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers([...capabilities], services);

    await expect(handlers["state.compareAndSet"]!(params, workspaceContext(async () => undefined)))
      .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED });
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("delegates exact company-scoped params with the invocation check and returns success", async () => {
    const assertCurrentInvocation = vi.fn(async () => undefined);
    const compareAndSet = vi.fn(async (_request: unknown, check: () => Promise<void>) => {
      await check();
      return { swapped: true };
    });
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);

    await expect(handlers["state.compareAndSet"]!(params, workspaceContext(assertCurrentInvocation)))
      .resolves.toEqual({ swapped: true });

    expect(compareAndSet).toHaveBeenCalledOnce();
    const [delegatedParams, check] = compareAndSet.mock.calls[0]!;
    expect(delegatedParams).toBe(params);
    expect(Object.keys(delegatedParams as object).sort()).toEqual([
      "expected", "namespace", "scopeId", "scopeKind", "stateKey", "value",
    ]);
    expect(check).toEqual(expect.any(Function));
    expect(assertCurrentInvocation.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns a compare conflict unchanged", async () => {
    const compareAndSet = vi.fn(async () => ({ swapped: false }));
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);

    await expect(handlers["state.compareAndSet"]!(params, workspaceContext(async () => undefined)))
      .resolves.toEqual({ swapped: false });
    expect(compareAndSet).toHaveBeenCalledOnce();
  });

  it("rejects invalid scopes, revoked checks, accessors, and unknown fields before delegation", async () => {
    const compareAndSet = vi.fn(async () => ({ swapped: true }));
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);
    const accessorParams = { ...params };
    Object.defineProperty(accessorParams, "scopeId", { enumerable: true, get: () => workspaceId });
    const unknownFieldParams = { ...params, extra: true };
    const unknownAccessorParams = { ...params };
    Object.defineProperty(unknownAccessorParams, "extra", { enumerable: true, get: () => true });
    const cases: Array<[unknown, WorkerHostCallContext | undefined]> = [
      [{ ...params, scopeKind: "instance" }, workspaceContext(async () => undefined)],
      [{ ...params, scopeId: foreignWorkspaceId }, workspaceContext(async () => undefined)],
      [{ ...params, scopeId: workspaceId.toUpperCase() }, workspaceContext(async () => undefined)],
      [params, workspaceContext(async () => undefined, foreignWorkspaceId)],
      [{ ...params, scopeId: undefined }, workspaceContext(async () => undefined)],
      [params, { invocationScope: { companyId: workspaceId } }],
      [params, workspaceContext((async () => "revoked") as unknown as () => Promise<void>)],
      [accessorParams, workspaceContext(async () => undefined)],
      [unknownFieldParams, workspaceContext(async () => undefined)],
      [unknownAccessorParams, workspaceContext(async () => undefined)],
    ];

    for (const [request, context] of cases) {
      await expect(handlers["state.compareAndSet"]!(request, context)).rejects.toThrow();
    }
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("rejects malformed and non-JSON conditional values without evaluating getters or delegating", async () => {
    const compareAndSet = vi.fn(async () => ({ swapped: true }));
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);
    let expectationGetterAccessed = false;
    const accessorExpected = Object.defineProperty({}, "exists", {
      enumerable: true,
      get() {
        expectationGetterAccessed = true;
        return false;
      },
    });
    const cyclicValue: Record<string, unknown> = {};
    cyclicValue.self = cyclicValue;
    let deepValue: unknown = "leaf";
    for (let depth = 0; depth < 65; depth++) deepValue = { next: deepValue };

    const cases: unknown[] = [
      { ...params, expected: accessorExpected },
      { ...params, expected: { exists: false, value: "not allowed" } },
      { ...params, expected: { exists: 0 } },
      { ...params, expected: { exists: true, value: undefined } },
      { ...params, value: { amount: Number.NaN } },
      { ...params, value: { amount: Number.POSITIVE_INFINITY } },
      { ...params, value: cyclicValue },
      { ...params, value: deepValue },
      { ...params, value: "x".repeat(262_145) },
    ];

    for (const request of cases) {
      await expect(handlers["state.compareAndSet"]!(request, workspaceContext(async () => undefined))).rejects.toThrow();
    }
    expect(expectationGetterAccessed).toBe(false);
    expect(compareAndSet).not.toHaveBeenCalled();
  });

  it("rejects unsupported conditional storage without falling back to ordinary set", async () => {
    const { services, state } = createStateServices();
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);

    await expect(handlers["state.compareAndSet"]!(params, workspaceContext(async () => undefined)))
      .rejects.toThrow("does not support conditional state storage");
    expect(state.set).not.toHaveBeenCalled();
  });

  it("rejects the service response if the invocation is revoked while the service is awaiting", async () => {
    let releaseService!: () => void;
    let serviceStarted!: () => void;
    const serviceGate = new Promise<void>(resolve => { releaseService = resolve; });
    const started = new Promise<void>(resolve => { serviceStarted = resolve; });
    const compareAndSet = vi.fn(async (_request: unknown, check: () => Promise<void>) => {
      await check();
      serviceStarted();
      await serviceGate;
      return { swapped: true };
    });
    const { services } = createStateServices(compareAndSet);
    const handlers = createHandlers(["plugin.state.read", "plugin.state.write"], services);
    let active = true;
    const assertCurrentInvocation = vi.fn(async () => {
      if (!active) throw new Error("invocation revoked");
    });

    const result = handlers["state.compareAndSet"]!(params, workspaceContext(assertCurrentInvocation));
    await started;
    active = false;
    releaseService();

    await expect(result).rejects.toThrow();
    expect(compareAndSet).toHaveBeenCalledOnce();
    expect(assertCurrentInvocation.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
