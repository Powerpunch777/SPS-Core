import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { describeSpsHostSupport } from "../services/sps-host-support.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

describe("SPS registered Host API support snapshot", () => {
  it("reports only registered own public handlers without invoking them or reading accessors", () => {
    const handler = vi.fn();
    const getter = vi.fn(() => handler);
    const handlers = Object.assign(Object.create({ "sps.runs.cancel": handler }), {
      "sps.connectivity.current": handler,
      "agents.sessions.getRun": handler, "sps.runtimes.list": handler,
      "sps.runs.dispatch": null, "secrets.resolve": handler, "config.get": handler,
      "agents.sessions.close": handler,
    });
    Object.defineProperty(handlers, "agents.list", { get: getter });
    expect(describeSpsHostSupport(handlers)).toEqual({
      contractVersion: "1.0", operations: ["agents.sessions.getRun", "sps.connectivity.current", "sps.runtimes.list"],
    });
    expect(handler).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports empty support rather than inferring from an API or package version", () => {
    expect(describeSpsHostSupport({})).toEqual({ contractVersion: "1.0", operations: [] });
    const a = describeSpsHostSupport({ "sps.runtimes.list": vi.fn() });
    a.operations.push("private.fake");
    expect(describeSpsHostSupport({ "sps.runtimes.list": vi.fn() }).operations).toEqual(["sps.runtimes.list"]);
  });

  it("passes the registered snapshot to a real Worker and refreshes it after restart", async () => {
    const runtimeHandler = vi.fn(async () => []);
    const connectivityHandler = vi.fn(async () => ({ state: "unavailable", transport: "native_tls",
      hostId: null, workspaceId: "11111111-1111-4111-8111-111111111111", authorization: "unknown",
      evidence: "none", observedAt: "2026-10-27T00:00:00.000Z" } as const));
    const handlers = { "sps.runtimes.list": runtimeHandler, "sps.connectivity.current": connectivityHandler };
    const manifest: PaperclipPluginManifestV1 = {
      id: "test.host-support", apiVersion: 1, version: "0.1.0", displayName: "Host support fixture",
      description: "Disposable transport fixture", author: "SPS", categories: ["automation"],
      capabilities: [], entrypoints: { worker: "worker.cjs" },
    };
    const handle = createPluginWorkerHandle(manifest.id, {
      entrypointPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/plugin-worker-host-support.cjs"),
      manifest, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "0.0.0" },
      apiVersion: 1, hostHandlers: handlers, autoRestart: false,
    });
    try {
      await handle.start();
      expect(await handle.call("getData", { key: "host-support", params: {} })).toEqual({
        support: { contractVersion: "1.0", operations: ["sps.connectivity.current", "sps.runtimes.list"] },
      });
      expect(runtimeHandler).not.toHaveBeenCalled();
      expect(connectivityHandler).not.toHaveBeenCalled();
      await handle.stop();
      delete (handlers as Partial<typeof handlers>)["sps.runtimes.list"];
      delete (handlers as Partial<typeof handlers>)["sps.connectivity.current"];
      await handle.start();
      expect(await handle.call("getData", { key: "host-support", params: {} })).toEqual({
        support: { contractVersion: "1.0", operations: [] },
      });
      expect(manifest.capabilities).toEqual([]);
    } finally {
      await handle.stop();
    }
  });
});
