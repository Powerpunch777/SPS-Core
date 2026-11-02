import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-stream-scope.cjs");
const manifest: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin stream scope",
  author: "SPS",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

describe("plugin worker stream scope bookkeeping", () => {
  it("keeps same-channel streams isolated by Workspace through close and crash", async () => {
    const onStreamNotification = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: fixturePath,
      manifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      autoRestart: false,
      onStreamNotification,
    });

    try {
      await handle.start();
      const call = (companyId: string, mode: string) => handle.call("getData", {
        key: "stream-scope",
        companyId,
        params: { mode },
      } as HostToWorkerMethods["getData"][0]);

      await call("workspace-a", "open");
      await call("workspace-b", "open");
      await call("workspace-a", "close");
      expect(onStreamNotification.mock.calls.map(([method, params]) => [method, params.companyId])).toEqual([
        ["streams.open", "workspace-a"],
        ["streams.open", "workspace-b"],
        ["streams.close", "workspace-a"],
      ]);

      await expect(call("workspace-b", "crash")).rejects.toThrow();
      await waitFor(() => onStreamNotification.mock.calls.some(([method, params]) =>
        method === "streams.close" && params.companyId === "workspace-b"));
      expect(onStreamNotification.mock.calls.map(([method, params]) => [method, params.companyId])).toEqual([
        ["streams.open", "workspace-a"],
        ["streams.open", "workspace-b"],
        ["streams.close", "workspace-a"],
        ["streams.close", "workspace-b"],
      ]);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops a stream notification that crosses the guarded invocation Workspace", async () => {
    const onStreamNotification = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: fixturePath,
      manifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      onStreamNotification,
    });

    try {
      await handle.start();
      await handle.call("getData", {
        key: "stream-scope",
        companyId: "workspace-a",
        params: { mode: "wrong-tenant", notificationCompanyId: "workspace-b" },
      } as HostToWorkerMethods["getData"][0], undefined, { assertCurrent: () => undefined });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onStreamNotification).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
