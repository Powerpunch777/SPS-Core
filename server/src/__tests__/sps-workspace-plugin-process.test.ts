import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { createSpsWorkspacePluginWorkers } from "../services/sps-workspace-plugin-workers.js";

const fakes = vi.hoisted(() => ({
  plugin: null as any,
  configs: new Map<string, any>(),
  present: new Set<string>(),
  policy: new Map<string, { policyId: string; revision: number }>(),
  epochs: new Map<string, string>(),
  active: new Map<string, boolean>(),
  stopHandler: undefined as undefined | ((workspaceId: string, reason: string, stoppedEpoch: string) => Promise<void>),
}));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({ getById: async () => fakes.plugin }) }));
vi.mock("../services/sps-workspace-plugin-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/sps-workspace-plugin-config.js")>(),
  createSpsWorkspacePluginConfigService: () => ({ get: async (workspaceId: string) => fakes.configs.get(workspaceId) }),
}));
vi.mock("../services/sps-plugin-authority-revision.js", () => ({
  readSpsPluginAuthorityRevision: async (_db: unknown, workspaceId: string) => fakes.policy.get(workspaceId),
  sameSpsPluginAuthorityRevision: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
}));
vi.mock("../services/sps-workspace-presence.js", () => ({
  readSpsWorkspacePresence: async (_db: unknown, workspaceId: string) => fakes.present.has(workspaceId),
}));
vi.mock("../services/sps-workspace-execution-control.js", () => ({
  assertSpsWorkspaceExecutionActive: async (_db: unknown, workspaceId: string, epoch: string) => {
    if (!fakes.active.get(workspaceId) || fakes.epochs.get(workspaceId) !== epoch) throw new Error("execution inactive");
  },
  withSpsWorkspaceExecutionAdmission: async (_db: unknown, workspaceId: string, action: (_tx: unknown, epoch: string) => unknown) => {
    if (!fakes.active.get(workspaceId)) throw new Error("execution inactive");
    return action({}, fakes.epochs.get(workspaceId)!);
  },
  registerSpsWorkspaceExecutionStopHandler: (_db: unknown, _name: string,
    handler: typeof fakes.stopHandler) => {
    fakes.stopHandler = handler;
    return () => { fakes.stopHandler = undefined; };
  },
}));

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const pluginKey = "sps.workspace-process-fixture";
const manifest: any = {
  id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Workspace process fixture", description: "Fixture",
  author: "SPS", categories: ["automation"], capabilities: ["plugin.state.read"],
  entrypoints: { worker: "./legacy.cjs", workspaceWorker: "./workspace.cjs" },
  workspaceConfigSchema: {
    type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false,
  },
};
const plugin = { id: pluginId, pluginKey, packageName: "@sps/workspace-process-fixture", packagePath: "/unused",
  version: "1.0.0", status: "ready", manifestJson: manifest } as PluginRecord;
const authority = (workspaceId: string) => ({ boundWorkspaceId: workspaceId, assertCurrent: async () => undefined });
const workspaceParams = (workspaceId: string) => ({
  key: "fixture.data", companyId: workspaceId, params: {}, renderEnvironment: null,
});

function workerOptions(label: string, entrypointPath: string): WorkerStartOptions {
  return {
    entrypointPath, manifest, config: { label },
    instanceInfo: { instanceId: "legacy-host", hostVersion: "1" }, apiVersion: 1,
    hostHandlers: { "config.get": async () => ({ label }) }, autoRestart: false,
  };
}

function fixtureSource(): string {
  return String.raw`const readline = require("node:readline");
let counter = 0;
let startupConfig;
let startupHostConfig;
let nextHostCall = 1;
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const hostCall = (method, params, invocationId, done) => {
  const id = "fixture-" + process.pid + "-" + nextHostCall++;
  pending.set(id, done);
  send({ jsonrpc: "2.0", id, method, params, ...(invocationId ? { paperclipInvocationId: invocationId } : {}) });
};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id != null && !message.method && pending.has(String(message.id))) {
    const done = pending.get(String(message.id)); pending.delete(String(message.id)); done(message.result); return;
  }
  if (message.method === "initialize") {
    startupConfig = message.params.config;
    hostCall("config.get", {}, undefined, (config) => {
      startupHostConfig = config;
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData", "performAction"] } });
    });
    return;
  }
  if (message.method === "getData") {
    counter += 1;
    const invocationId = message.paperclipInvocation && message.paperclipInvocation.id;
    hostCall("config.get", {}, invocationId, (config) => {
      send({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid, counter, startupConfig, startupHostConfig, hostConfig: config } });
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => { rl.close(); process.exit(0); });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method unavailable" } });
});`;
}

describe("SPS Workspace Plugin real process lifecycle", () => {
  beforeEach(() => {
    fakes.plugin = plugin; fakes.configs.clear(); fakes.present.clear(); fakes.policy.clear(); fakes.epochs.clear(); fakes.active.clear();
    fakes.stopHandler = undefined;
    for (const [id, label] of [[workspaceA, "a"], [workspaceB, "b"]] as const) {
      fakes.present.add(id);
      fakes.configs.set(id, { configJson: { label: `workspace-${label}` }, revision: `revision-${label}`, updatedAt: null });
      fakes.policy.set(id, { policyId: `policy-${label}`, revision: 1 });
      fakes.epochs.set(id, "1"); fakes.active.set(id, true);
    }
  });
  afterEach(() => vi.clearAllMocks());

  it("keeps real Workspace and legacy processes isolated across stop, resume and stale invalidation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sps-workspace-process-"));
    const entrypoint = path.join(root, "workspace.cjs");
    await writeFile(entrypoint, fixtureSource(), "utf8");
    const manager = createPluginWorkerManager();
    const factory = createSpsWorkspacePluginWorkers({} as any, manager, {
      localPluginDir: root,
      resolveEntrypoint: async () => entrypoint,
      buildServices: (_record, workspaceId) => ({
        dispose: () => undefined,
        config: { get: async () => fakes.configs.get(workspaceId)?.configJson },
      } as any),
    });
    let factoryClosed = false;
    let managerClosed = false;
    try {
      const host = await manager.startWorker(pluginId, workerOptions("legacy-host", entrypoint));
      const call = (workspaceId: string, params = workspaceParams(workspaceId)) => factory.call(
        workspaceId, pluginId, "getData", params as any, 2_000, authority(workspaceId));
      const [firstA, firstB] = await Promise.all([call(workspaceA), call(workspaceB)]) as any[];
      const firstHost = await manager.call(pluginId, "getData", workspaceParams(workspaceA) as any, 2_000) as any;
      const workerA = manager.getWorkspaceWorker(workspaceA, pluginId)!;
      const workerB = manager.getWorkspaceWorker(workspaceB, pluginId)!;
      const hostPid = host.diagnostics().pid;
      expect(new Set([firstA.pid, firstB.pid, hostPid]).size).toBe(3);
      expect(firstA).toMatchObject({ counter: 1, startupConfig: { label: "workspace-a" }, startupHostConfig: { label: "workspace-a" }, hostConfig: { label: "workspace-a" } });
      expect(firstB).toMatchObject({ counter: 1, startupConfig: { label: "workspace-b" }, startupHostConfig: { label: "workspace-b" }, hostConfig: { label: "workspace-b" } });
      expect(firstHost).toMatchObject({ pid: hostPid, counter: 1, startupConfig: { label: "legacy-host" }, startupHostConfig: { label: "legacy-host" }, hostConfig: { label: "legacy-host" } });
      expect(manager.getWorker(pluginId)).toBe(host);

      const countBeforeDeniedCall = await call(workspaceA) as any;
      expect(countBeforeDeniedCall.counter).toBe(2);
      await expect(call(workspaceA, workspaceParams(workspaceB))).rejects.toThrow();
      await expect(factory.call(workspaceB, pluginId, "getData", workspaceParams(workspaceB) as any, 2_000,
        authority(workspaceA))).rejects.toThrow();
      const afterDeniedCall = await call(workspaceA) as any;
      expect(afterDeniedCall.counter).toBe(3);

      await fakes.stopHandler!(workspaceA, "stop", "2");
      expect(workerA.status).toBe("stopped");
      expect(workerB.status).toBe("running");
      expect(host.status).toBe("running");
      const stillB = await call(workspaceB) as any;
      expect(stillB.pid).toBe(firstB.pid);
      expect(stillB.counter).toBe(2);
      const stillHost = await manager.call(pluginId, "getData", workspaceParams(workspaceA) as any, 2_000) as any;
      expect(stillHost).toMatchObject({ pid: hostPid, counter: 2, hostConfig: { label: "legacy-host" } });

      fakes.active.set(workspaceA, false);
      await expect(call(workspaceA)).rejects.toThrow();
      fakes.epochs.set(workspaceA, "3"); fakes.active.set(workspaceA, true);
      fakes.configs.set(workspaceA, { configJson: { label: "workspace-a-resumed" }, revision: "revision-a-resumed", updatedAt: null });
      const resumed = await call(workspaceA) as any;
      const resumedHandle = manager.getWorkspaceWorker(workspaceA, pluginId)!;
      expect(resumed.pid).not.toBe(firstA.pid);
      expect(resumed.counter).toBe(1);
      expect(resumed.startupConfig).toEqual({ label: "workspace-a-resumed" });
      await factory.invalidate(workspaceA, pluginId, "revision-a");
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBe(resumedHandle);
      expect(resumedHandle.status).toBe("running");

      await factory.shutdown(); factoryClosed = true;
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBeUndefined();
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)).toBeUndefined();
      expect(host.status).toBe("running");
      await manager.shutdown(); managerClosed = true;
      expect(host.status).toBe("stopped");
    } finally {
      // Preserve fixture files whenever either shutdown fails: a child may still
      // be executing code from this directory, so deleting it would hide a leak.
      try { if (!factoryClosed) { await factory.shutdown(); factoryClosed = true; } } catch { /* preserve fixture */ }
      try { if (!managerClosed) { await manager.shutdown(); managerClosed = true; } } catch { /* preserve fixture */ }
      if (factoryClosed && managerClosed) await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
