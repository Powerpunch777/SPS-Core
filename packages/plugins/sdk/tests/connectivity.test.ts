import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createErrorResponse,
  createHostClientHandlers,
  createRequest,
  createSuccessResponse,
  definePlugin,
  InvocationScopeDeniedError,
  parseMessage,
  serializeMessage,
  startWorkerRpcHost,
} from "../src/index.js";
import type { HostServices } from "../src/host-client-factory.js";
import type { PluginInvocationContext } from "../src/protocol.js";
import type { PluginCapability } from "@paperclipai/shared";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const HOST_ID = "33333333-3333-4333-8333-333333333333";
const OBSERVED_AT = "2026-10-27T01:02:03.000Z";
const verified = (workspaceId = WORKSPACE_ID) => ({
  state: "verified" as const,
  transport: "native_tls" as const,
  hostId: HOST_ID,
  workspaceId,
  authorization: "authorized" as const,
  evidence: "authenticated_request" as const,
  observedAt: OBSERVED_AT,
  privateKey: "must-not-be-projected",
});

function connectivityHandler(capabilities: readonly PluginCapability[]) {
  return createHostClientHandlers({
    pluginId: "sps.connectivity-test",
    capabilities,
    services: {} as HostServices,
  })["sps.connectivity.current"];
}

describe("SPS connectivity capability and invocation contract", () => {
  it("requires the dedicated capability before consulting the Native provider", async () => {
    const read = vi.fn(async () => verified());
    const handler = connectivityHandler([]);
    await expect(handler({}, { invocationScope: { companyId: WORKSPACE_ID }, readNativeConnectivity: read as never }))
      .rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(read).not.toHaveBeenCalled();
  });

  it("requires a current Workspace scope and rejects target selectors without evaluating accessors", async () => {
    const read = vi.fn(async () => verified());
    const handler = connectivityHandler(["sps.connectivity.read"]);
    await expect(handler({}, { readNativeConnectivity: read as never })).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(handler({}, { invalidInvocationScope: true, readNativeConnectivity: read as never }))
      .rejects.toBeInstanceOf(InvocationScopeDeniedError);

    let getterCalls = 0;
    const targetSelector = Object.defineProperty({}, "hostId", {
      enumerable: true,
      get() { getterCalls++; throw new Error("target selector getter ran"); },
    });
    await expect(handler(targetSelector as never, {
      invocationScope: { companyId: WORKSPACE_ID }, readNativeConnectivity: read as never,
    })).rejects.toBeInstanceOf(TypeError);
    const companySelector = Object.defineProperty({}, "companyId", {
      enumerable: true,
      get() { getterCalls++; throw new Error("Workspace selector getter ran"); },
    });
    await expect(handler(companySelector as never, {
      invocationScope: { companyId: WORKSPACE_ID }, readNativeConnectivity: read as never,
    })).rejects.toBeInstanceOf(TypeError);
    await expect(handler({ workspaceId: WORKSPACE_ID } as never, {
      invocationScope: { companyId: WORKSPACE_ID }, readNativeConnectivity: read as never,
    })).rejects.toBeInstanceOf(TypeError);
    expect(getterCalls).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns unavailable for trusted scoped calls without a Native provider", async () => {
    const handler = connectivityHandler(["sps.connectivity.read"]);
    await expect(handler({}, { invocationScope: { companyId: WORKSPACE_ID } })).resolves.toMatchObject({
      state: "unavailable", transport: "native_tls", hostId: null,
      workspaceId: WORKSPACE_ID, authorization: "unknown", evidence: "none",
    });
  });

  it("projects only verified evidence for the invocation Workspace and denies cross-Workspace evidence", async () => {
    const read = vi.fn(async () => verified());
    const handler = connectivityHandler(["sps.connectivity.read"]);
    await expect(handler({}, {
      invocationScope: { companyId: WORKSPACE_ID }, readNativeConnectivity: read as never,
    })).resolves.toEqual({
      state: "verified", transport: "native_tls", hostId: HOST_ID,
      workspaceId: WORKSPACE_ID, authorization: "authorized", evidence: "authenticated_request", observedAt: OBSERVED_AT,
    });
    expect(read).toHaveBeenCalledTimes(1);

    const crossWorkspace = connectivityHandler(["sps.connectivity.read"]);
    await expect(crossWorkspace({}, { invocationScope: { companyId: WORKSPACE_ID },
      readNativeConnectivity: async () => verified(OTHER_WORKSPACE_ID) as never,
    })).rejects.toBeInstanceOf(InvocationScopeDeniedError);
  });

  it("carries the public SDK facade call through worker RPC into the Core gated provider", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const readline = createInterface({ input: workerToHost });
    const pending = new Map<string, (value: unknown) => void>();
    const outbound: Array<{ method: string; params: unknown; paperclipInvocationId?: string }> = [];
    const provider = vi.fn(async () => verified());
    const invocationId = "opaque-invocation-reference";
    const handlers = createHostClientHandlers({
      pluginId: "sps.connectivity-test",
      capabilities: ["sps.connectivity.read"],
      services: {} as HostServices,
    });
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("connectivity", async () => await ctx.sps.connectivity.current());
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    const callWorker = (method: string, params: unknown, invocation?: PluginInvocationContext) => {
      const id = `host-${pending.size + outbound.length + 1}`;
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, value => {
          if (value && typeof value === "object" && "error" in value) reject(new Error("worker RPC failed"));
          else resolve(value && typeof value === "object" && "result" in value ? value.result : value);
        });
      });
      const request = createRequest(method, params, id);
      hostToWorker.write(serializeMessage(invocation ? { ...request, paperclipInvocation: invocation } : request));
      return response;
    };

    readline.on("line", line => {
      const message = parseMessage(line);
      if (!message || typeof message !== "object") return;
      if ("method" in message && message.method === "sps.connectivity.current") {
        const request = message as { id: string | number; method: string; params: unknown; paperclipInvocationId?: string };
        outbound.push({ method: request.method, params: request.params, paperclipInvocationId: request.paperclipInvocationId });
        void handlers["sps.connectivity.current"](request.params as never, {
          invocationScope: { companyId: WORKSPACE_ID },
          readNativeConnectivity: provider as never,
        }).then(
          result => hostToWorker.write(serializeMessage(createSuccessResponse(request.id, result))),
          error => hostToWorker.write(serializeMessage(createErrorResponse(request.id, -32000, String(error)))),
        );
        return;
      }
      if ("id" in message && typeof message.id === "string") {
        const resolve = pending.get(message.id);
        if (resolve) { pending.delete(message.id); resolve(message); }
      }
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "sps.connectivity-test", apiVersion: 1, version: "1.0.0",
          displayName: "Connectivity contract test", description: "Test", author: "SPS",
          categories: ["automation"], capabilities: ["sps.connectivity.read"], entrypoints: {},
        },
        config: {}, databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });
      await expect(callWorker("performAction", { key: "connectivity", params: {} }, {
        id: invocationId, scope: { companyId: WORKSPACE_ID },
      })).resolves.toEqual({
        state: "verified", transport: "native_tls", hostId: HOST_ID,
        workspaceId: WORKSPACE_ID, authorization: "authorized", evidence: "authenticated_request", observedAt: OBSERVED_AT,
      });
      expect(outbound).toEqual([{ method: "sps.connectivity.current", params: {}, paperclipInvocationId: invocationId }]);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      worker.stop();
      readline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
