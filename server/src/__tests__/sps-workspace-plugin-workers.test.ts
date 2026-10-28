import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { createSpsWorkspacePluginWorkers, resolveSpsWorkspacePluginEntrypoint } from "../services/sps-workspace-plugin-workers.js";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";

const fakes = vi.hoisted(() => ({
  fork: vi.fn(),
  plugin: null as any,
  configs: new Map<string, any>(),
  policy: new Map<string, { policyId: string; revision: number }>(),
  epochs: new Map<string, string>(),
  active: new Map<string, boolean>(),
  stopHandler: undefined as undefined | ((workspaceId: string, reason: string, stoppedEpoch: string) => Promise<void>),
  pendingObserver: null as null | ((workspaceId: string) => number),
}));

vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), fork: fakes.fork }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({ getById: async () => fakes.plugin }) }));
vi.mock("../services/sps-workspace-plugin-config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/sps-workspace-plugin-config.js")>(),
  createSpsWorkspacePluginConfigService: () => ({ get: async (workspaceId: string) => fakes.configs.get(workspaceId) }),
}));
vi.mock("../services/sps-plugin-authority-revision.js", () => ({
  readSpsPluginAuthorityRevision: async (_db: unknown, workspaceId: string) => fakes.policy.get(workspaceId),
  sameSpsPluginAuthorityRevision: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
}));
vi.mock("../services/sps-workspace-execution-control.js", () => ({
  assertSpsWorkspaceExecutionActive: async (_db: unknown, workspaceId: string, epoch: string) => {
    if (!fakes.active.get(workspaceId) || fakes.epochs.get(workspaceId) !== epoch) throw new Error("execution inactive");
  },
  withSpsWorkspaceExecutionAdmission: async (_db: unknown, workspaceId: string, action: (_tx: unknown, epoch: string) => unknown) => {
    if (!fakes.active.get(workspaceId)) throw new Error("execution inactive");
    return action({}, fakes.epochs.get(workspaceId)!);
  },
  registerSpsWorkspaceExecutionStopHandler: (_db: unknown, _name: string, handler: typeof fakes.stopHandler,
    pendingObserver?: typeof fakes.pendingObserver) => {
    fakes.stopHandler = handler;
    fakes.pendingObserver = pendingObserver;
    return () => { fakes.stopHandler = undefined; fakes.pendingObserver = null; };
  },
}));
type Message = Record<string, unknown>;
class FakeWorker extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly methods: string[] = [];
  initializeConfig: unknown;
  private buffer = "";
  private childRequest = 1;
  private initializeId: unknown;
  private initialized = false;
  private readonly pendingHostCalls = new Map<string, { kind: "initialize" | "data"; parentId: unknown }>();
  constructor(pid: number) {
    super(); this.pid = pid;
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      try {
        this.buffer += chunk.toString();
        let index = this.buffer.indexOf("\n");
        while (index >= 0) {
          const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
          if (line.trim()) this.receive(JSON.parse(line) as Message);
          index = this.buffer.indexOf("\n");
        }
        callback();
      } catch (error) { callback(error as Error); }
    } });
  }
  private send(message: Message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  private response(id: unknown, result: unknown) { this.send({ jsonrpc: "2.0", id, result }); }
  private reject(id: unknown, message: string) {
    this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  }
  private requestConfig(kind: "initialize" | "data", parentId: unknown, invocationId?: unknown) {
    const id = `child-${this.pid}-${this.childRequest++}`;
    this.pendingHostCalls.set(id, { kind, parentId });
    this.methods.push("config.get");
    this.send({ jsonrpc: "2.0", id, method: "config.get", params: {},
      ...(typeof invocationId === "string" ? { paperclipInvocationId: invocationId } : {}) });
  }
  private receive(message: Message) {
    const method = String(message.method ?? "");
    if (method) this.methods.push(method);
    if (typeof message.id === "string" && !method) {
      const pending = this.pendingHostCalls.get(message.id);
      if (!pending) {
        if (!this.initialized && this.initializeId !== undefined) {
          this.reject(this.initializeId, "Unknown Host callback response");
        } else {
          for (const [id, call] of this.pendingHostCalls) {
            if (call.kind === "data") this.reject(call.parentId, "Unknown Host callback response");
            this.pendingHostCalls.delete(id);
          }
        }
        return;
      }
      this.pendingHostCalls.delete(message.id);
      if (message.error) {
        const reason = (message.error as Message).message;
        this.reject(pending.kind === "initialize" ? this.initializeId : pending.parentId,
          typeof reason === "string" ? reason : "Host callback failed");
      } else if (pending.kind === "initialize") {
        this.initializeConfig = message.result;
        this.initialized = true;
        this.response(this.initializeId, { ok: true, supportedMethods: ["getData", "performAction"] });
      } else {
        this.response(pending.parentId, { pid: this.pid, startupConfig: this.initializeConfig, hostConfig: message.result });
      }
      return;
    }
    if (method === "initialize") {
      this.initializeId = message.id;
      this.requestConfig("initialize", message.id);
    } else if (method === "getData") {
      const invocation = message.paperclipInvocation as Message;
      this.requestConfig("data", message.id, invocation.id);
    } else if (method === "shutdown") {
      this.response(message.id, {}); setImmediate(() => this.close());
    } else if (method === "health") this.response(message.id, { ok: true });
  }
  close() {
    this.stdout.end(); this.stderr.end(); this.emit("exit", 0, null); this.emit("close", 0, null);
  }
}

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const pluginKey = "sps.workspace-worker-fixture";
const manifest: any = {
  id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Workspace worker fixture", description: "Fixture",
  author: "SPS", categories: ["automation"], capabilities: ["plugin.state.read"],
  entrypoints: { worker: "./legacy.js", workspaceWorker: "./workspace-worker.js" },
  workspaceConfigSchema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false },
};
const plugin = { id: pluginId, pluginKey, packageName: "@sps/workspace-worker-fixture", packagePath: "/fixture/package",
  version: "1.0.0", status: "ready", manifestJson: manifest } as PluginRecord;
const children: FakeWorker[] = [];
const authority = (workspaceId: string) => ({ boundWorkspaceId: workspaceId, assertCurrent: async () => undefined });
const workerOptions = (label: string): WorkerStartOptions => ({
  entrypointPath: "host-worker.js", manifest, config: { label }, instanceInfo: { instanceId: "host", hostVersion: "1" },
  apiVersion: 1, hostHandlers: { "config.get": async () => ({ label }) },
});

describe("SPS Workspace Plugin worker factory", () => {
  beforeEach(() => {
    fakes.fork.mockReset(); children.length = 0; fakes.policy.clear(); fakes.epochs.clear(); fakes.active.clear();
    fakes.configs.clear(); fakes.stopHandler = undefined; fakes.pendingObserver = null; fakes.plugin = plugin;
    for (const id of [workspaceA, workspaceB]) {
      fakes.policy.set(id, { policyId: `policy-${id}`, revision: 1 }); fakes.epochs.set(id, "1"); fakes.active.set(id, true);
      fakes.configs.set(id, { configJson: { label: `config-${id === workspaceA ? "a" : "b"}` }, revision: `config-rev-${id}`, updatedAt: null });
    }
    fakes.fork.mockImplementation(() => { const child = new FakeWorker(70_000 + children.length); children.push(child); return child as unknown as ChildProcess; });
  });
  afterEach(() => vi.clearAllMocks());

  it("starts one worker per Workspace with current config, routes owned calls, and stops only the selected owner", async () => {
    const manager = createPluginWorkerManager();
    const disposed: string[] = [];
    const factory = createSpsWorkspacePluginWorkers({} as any, manager, {
      localPluginDir: "/unused",
      resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      buildServices: (_record, workspaceId) => ({ dispose: () => disposed.push(workspaceId) } as any),
    });
    const hostCall = vi.spyOn(manager, "call");
    const workspaceCall = vi.spyOn(manager, "callWorkspaceWorker");
    const host = await manager.startWorker(pluginId, workerOptions("host"));
    try {
      const action = (workspaceId: string) => factory.call(workspaceId, pluginId, "getData", {
        key: "fixture.data", companyId: workspaceId, params: {}, renderEnvironment: null,
      } as any, 1_000, authority(workspaceId));
      const [resultA, resultB] = await Promise.all([action(workspaceA), action(workspaceB)]) as any[];
      expect(resultA.startupConfig).toEqual({ label: "config-a" });
      expect(resultB.startupConfig).toEqual({ label: "config-b" });
      expect(resultA.hostConfig).toEqual({ label: "config-a" });
      expect(resultB.hostConfig).toEqual({ label: "config-b" });
      expect(resultA.pid).not.toBe(resultB.pid);
      expect(manager.getWorker(pluginId)).toBe(host);
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)?.workspaceId).toBe(workspaceA);
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)?.workspaceId).toBe(workspaceB);
      expect(fakes.pendingObserver?.(workspaceA)).toBe(1);
      expect(fakes.pendingObserver?.(workspaceB)).toBe(1);
      const observePending = fakes.pendingObserver!;
      // The concurrently running legacy Host worker is not charged to either Workspace.
      expect(fakes.pendingObserver?.("99999999-9999-4999-8999-999999999999")).toBe(0);
      expect(children.map(child => child.methods).filter(methods => methods.includes("getData"))).toHaveLength(2);
      expect(children.filter(child => child.methods.includes("getData")).every(child => child.methods.includes("config.get"))).toBe(true);
      expect(workspaceCall).toHaveBeenCalledTimes(2);
      expect(hostCall).not.toHaveBeenCalled();

      const handler = fakes.stopHandler!;
      await handler(workspaceA, "stop", "2");
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBeUndefined();
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)?.status).toBe("running");
      expect(manager.getWorker(pluginId)).toBe(host);
      expect(fakes.pendingObserver?.(workspaceA)).toBe(0);
      expect(fakes.pendingObserver?.(workspaceB)).toBe(1);
      expect(disposed).toEqual([workspaceA]);

      fakes.active.set(workspaceA, false);
      await expect(action(workspaceA)).rejects.toThrow();
      fakes.epochs.set(workspaceA, "3"); fakes.active.set(workspaceA, true);
      const resumed = await action(workspaceA) as any;
      expect(resumed.startupConfig).toEqual({ label: "config-a" });
      const resumedHandle = manager.getWorkspaceWorker(workspaceA, pluginId);
      expect(resumedHandle?.status).toBe("running");
      await handler(workspaceA, "delayed-stop", "2");
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBe(resumedHandle);
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)?.status).toBe("running");

      await factory.shutdown();
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBeUndefined();
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)).toBeUndefined();
      expect(observePending(workspaceA)).toBe(0);
      expect(observePending(workspaceB)).toBe(0);
      expect(manager.getWorker(pluginId)).toBe(host);
      await manager.shutdown();
      expect(host.status).toBe("stopped");
    } finally {
      await factory.shutdown();
      await manager.shutdown();
    }
  });

  it("replaces a runtime after config revision change and never lets a stale invalidation retire the new record", async () => {
    const manager = createPluginWorkerManager();
    const factory = createSpsWorkspacePluginWorkers({} as any, manager, {
      localPluginDir: "/unused", resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      buildServices: () => ({ dispose: vi.fn() } as any),
    });
    const call = () => factory.call(workspaceA, pluginId, "getData", {
      key: "fixture.data", companyId: workspaceA, params: {}, renderEnvironment: null,
    } as any, 1_000, authority(workspaceA));
    try {
      const first = await call() as any;
      const previousRevision = `config-rev-${workspaceA}`;
      fakes.configs.set(workspaceA, { configJson: { label: "config-a-new" }, revision: "config-rev-new", updatedAt: null });
      await factory.invalidate(workspaceA, pluginId, previousRevision);
      const second = await call() as any;
      expect(second.pid).not.toBe(first.pid);
      expect(second.startupConfig).toEqual({ label: "config-a-new" });
      const fresh = manager.getWorkspaceWorker(workspaceA, pluginId);
      await factory.invalidate(workspaceA, pluginId, previousRevision);
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBe(fresh);
      expect(fresh?.status).toBe("running");
    } finally { await factory.shutdown(); await manager.shutdown(); }
  });

  it("allows a later shutdown retry after an unconfirmed stop while retaining ownership until closure", async () => {
    const manager = createPluginWorkerManager();
    const disposed: string[] = [];
    const factory = createSpsWorkspacePluginWorkers({} as any, manager, {
      localPluginDir: "/unused", resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      buildServices: (_record, workspaceId) => ({ dispose: () => disposed.push(workspaceId) } as any),
    });
    const action = factory.call(workspaceA, pluginId, "getData", {
      key: "fixture.data", companyId: workspaceA, params: {}, renderEnvironment: null,
    } as any, 1_000, authority(workspaceA));
    try {
      await action;
      const handle = manager.getWorkspaceWorker(workspaceA, pluginId)!;
      const retainedStopHandler = fakes.stopHandler;
      const originalStop = manager.stopWorkspaceWorkers.bind(manager);
      const stop = vi.spyOn(manager, "stopWorkspaceWorkers")
        .mockRejectedValueOnce(new Error("stop not confirmed"))
        .mockImplementation((...args) => originalStop(...args));

      const firstAttempt = factory.shutdown();
      expect(factory.shutdown()).toBe(firstAttempt);
      await expect(firstAttempt).rejects.toThrow();
      expect(handle.status).toBe("running");
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBe(handle);
      expect(disposed).toEqual([]);
      expect(fakes.stopHandler).toBe(retainedStopHandler);
      expect(fakes.pendingObserver?.(workspaceA)).toBe(1);
      expect(() => createSpsWorkspacePluginWorkers({} as any, manager, {
        localPluginDir: "/unused", resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      })).toThrow();

      await factory.shutdown();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(handle.status).toBe("stopped");
      expect(manager.getWorkspaceWorker(workspaceA, pluginId)).toBeUndefined();
      expect(disposed).toEqual([workspaceA]);
      expect(fakes.stopHandler).toBeUndefined();
      expect(fakes.pendingObserver).toBeNull();

      const nextFactory = createSpsWorkspacePluginWorkers({} as any, manager, {
        localPluginDir: "/unused", resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      });
      await nextFactory.shutdown();
    } finally {
      await factory.shutdown();
      await manager.shutdown();
    }
  });

  it("binds stream publication and retirement to the owning Workspace, policy and live invocation", async () => {
    const manager = createPluginWorkerManager();
    const starts = new Map<string, WorkerStartOptions>();
    const originalStart = manager.startWorkspaceWorker.bind(manager);
    vi.spyOn(manager, "startWorkspaceWorker").mockImplementation((workspaceId, id, options) => {
      starts.set(workspaceId, options);
      return originalStart(workspaceId, id, options);
    });
    const bus = createPluginStreamBus();
    const observedA: unknown[] = [], observedB: unknown[] = [];
    bus.subscribe(pluginId, "progress", workspaceA, (event, kind) => observedA.push({ event, kind }));
    bus.subscribe(pluginId, "progress", workspaceB, (event, kind) => observedB.push({ event, kind }));
    const factory = createSpsWorkspacePluginWorkers({} as any, manager, {
      localPluginDir: "/unused", resolveEntrypoint: async () => "/fixture/workspace-worker.js",
      buildServices: () => ({ dispose: vi.fn() } as any), streamBus: bus,
    });
    const call = (workspaceId: string) => factory.call(workspaceId, pluginId, "getData", {
      key: "fixture.data", companyId: workspaceId, params: {}, renderEnvironment: null,
    } as any, 1_000, authority(workspaceId));
    try {
      await call(workspaceA); await call(workspaceB);
      const streamA = starts.get(workspaceA)!.onStreamNotification!;
      const streamB = starts.get(workspaceB)!.onStreamNotification!;
      const selectedA = { channel: "progress", companyId: workspaceA };
      const selectedB = { channel: "progress", companyId: workspaceB };
      await streamA("streams.open", selectedB, "generation-a", () => true);
      expect(observedB).toEqual([]);
      await streamA("streams.open", selectedA, "generation-a", () => false);
      expect(observedA).toEqual([]);
      await streamA("streams.open", selectedA, "generation-a", () => true);
      await streamB("streams.open", selectedB, "generation-b", () => true);
      await streamA("streams.emit", { ...selectedA, event: { progress: 1 } }, "generation-a", () => true);
      expect(observedA.at(-1)).toEqual({ kind: "message", event: { progress: 1 } });
      fakes.policy.set(workspaceA, { policyId: "changed", revision: 2 });
      await expect(streamA("streams.emit", { ...selectedA, event: { progress: 2 } }, "generation-a", () => true))
        .rejects.toThrow();
      expect(observedA).toHaveLength(2);
      await fakes.stopHandler!(workspaceA, "stop", "2");
      expect(bus.ownerChannelCount(pluginId, workspaceA)).toBe(0);
      expect(bus.ownerChannelCount(pluginId, workspaceB)).toBe(1);
      expect(observedA.at(-1)).toEqual({ kind: "close", event: selectedA });
      expect(manager.getWorkspaceWorker(workspaceB, pluginId)?.status).toBe("running");
    } finally { await factory.shutdown(); await manager.shutdown(); }
  });

  it("resolves only regular files inside the declared package entry and rejects traversal without fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sps-workspace-entry-"));
    const packageDir = path.join(root, "pkg");
    const sibling = path.join(root, "sibling.js");
    await mkdir(packageDir);
    await writeFile(path.join(packageDir, "worker.js"), "export {};");
    await writeFile(sibling, "export {};");
    try {
      await expect(resolveSpsWorkspacePluginEntrypoint({ ...plugin, packagePath: packageDir,
        manifestJson: { ...manifest, entrypoints: { ...manifest.entrypoints, workspaceWorker: "./worker.js" } } } as PluginRecord, root))
        .resolves.toBe(await import("node:fs/promises").then(fs => fs.realpath(path.join(packageDir, "worker.js"))));
      await expect(resolveSpsWorkspacePluginEntrypoint({ ...plugin, packagePath: packageDir,
        manifestJson: { ...manifest, entrypoints: { ...manifest.entrypoints, workspaceWorker: "../sibling.js" } } } as PluginRecord, root))
        .rejects.toThrow(/unavailable/i);
      await expect(resolveSpsWorkspacePluginEntrypoint({ ...plugin, packagePath: packageDir,
        manifestJson: { ...manifest, entrypoints: { ...manifest.entrypoints, workspaceWorker: sibling } } } as PluginRecord, root))
        .rejects.toThrow(/unavailable/i);
      await expect(resolveSpsWorkspacePluginEntrypoint({ ...plugin, packagePath: packageDir,
        manifestJson: { ...manifest, entrypoints: { worker: "./legacy.js" } } } as PluginRecord, root))
        .rejects.toThrow(/unavailable/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
