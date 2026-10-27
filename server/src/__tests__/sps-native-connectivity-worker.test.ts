import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers, type HostServices } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { createPluginWorkerHandle, type WorkerInvocationAuthority } from "../services/plugin-worker-manager.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const HOST_ID = "33333333-3333-4333-8333-333333333333";
const OBSERVED_AT = "2026-10-27T01:02:03.000Z";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(TEST_DIR, "fixtures", "plugin-worker-sps-connectivity.cjs");
const PUBLIC_SDK_URL = pathToFileURL(path.resolve(TEST_DIR, "../../../../sps-plugin-sdk/runtime/index.mjs")).href;

describe("Native connectivity through the public SDK worker facade", () => {
  it("uses host-issued Workspace authority and denies a revoked invocation", async () => {
    let active = true;
    const assertCurrent = vi.fn(() => { if (!active) throw new Error("invocation was revoked"); });
    const readNativeConnectivity = vi.fn(async () => ({
      state: "verified" as const,
      transport: "native_tls" as const,
      hostId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      authorization: "authorized" as const,
      evidence: "authenticated_request" as const,
      observedAt: OBSERVED_AT,
      privateKey: "not-for-the-plugin",
    }));
    const baseHandlers = createHostClientHandlers({
      pluginId: "sps.connectivity-worker-test",
      capabilities: ["sps.connectivity.read"],
      services: {} as HostServices,
    });
    const read = baseHandlers["sps.connectivity.current"];
    let workerContext: unknown;
    const hostHandlers = {
      ...baseHandlers,
      "sps.connectivity.current": async (...args: Parameters<typeof read>) => {
        const [params, context] = args;
        workerContext = context;
        return await read(params, context);
      },
    };
    const handle = createPluginWorkerHandle("sps.connectivity-worker-test", {
      entrypointPath: FIXTURE,
      manifest: {
        id: "sps.connectivity-worker-test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "SPS connectivity test",
        description: "SPS connectivity test worker",
        author: "SPS",
        categories: ["automation"],
        capabilities: ["sps.connectivity.read"],
        entrypoints: { worker: "dist/worker.js" },
      },
      config: {},
      instanceInfo: { instanceId: "connectivity-test-instance", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers,
      autoRestart: false,
    });
    const authority: WorkerInvocationAuthority = { assertCurrent, readNativeConnectivity };

    try {
      await handle.start();
      const result = await handle.call("getData", {
        key: "connectivity",
        companyId: WORKSPACE_ID,
        params: { publicSdkUrl: PUBLIC_SDK_URL },
      } as never, 5000, authority) as {
        connectivity: Record<string, unknown>;
        nestedInvocationId: string;
      };
      expect(result.connectivity).toEqual({
        state: "verified", transport: "native_tls", hostId: HOST_ID,
        workspaceId: WORKSPACE_ID, authorization: "authorized", evidence: "authenticated_request", observedAt: OBSERVED_AT,
      });
      expect(result.nestedInvocationId).toMatch(/^sps-guarded:/);
      expect(workerContext).toMatchObject({ invocationScope: { companyId: WORKSPACE_ID } });
      expect(workerContext).not.toHaveProperty("hostId");
      expect(workerContext).not.toHaveProperty("userId");
      expect(workerContext).not.toHaveProperty("authority");
      expect(readNativeConnectivity).toHaveBeenCalledTimes(1);

      active = false;
      await expect(handle.call("getData", {
        key: "connectivity",
        companyId: WORKSPACE_ID,
        params: { publicSdkUrl: PUBLIC_SDK_URL },
      } as never, 5000, authority)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(readNativeConnectivity).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
