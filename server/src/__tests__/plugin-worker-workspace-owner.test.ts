import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import {
  createPluginWorkerManager,
  type WorkerInvocationAuthority,
  type WorkerStartOptions,
} from "../services/plugin-worker-manager.js";

const childProcessMock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  fork: childProcessMock.fork,
}));

type JsonRecord = Record<string, unknown>;

class FakeNdjsonWorker extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: JsonRecord[] = [];
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true);
  readonly stdin: Writable;
  holdShutdownClose = false;
  exited = false;
  private buffer = "";
  private nextChildRequest = 1;
  private initializeId: unknown;
  private startupConfigRequestId: string | null = null;
  private initializedConfig: unknown;
  private startupConfig: unknown;
  private readonly pendingHostCalls = new Map<string, JsonRecord>();

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.buffer += chunk.toString();
          let newline = this.buffer.indexOf("\n");
          while (newline >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim()) this.receive(JSON.parse(line) as JsonRecord);
            newline = this.buffer.indexOf("\n");
          }
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  private writeToManager(message: JsonRecord): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private respond(id: unknown, result: unknown): void {
    this.writeToManager({ jsonrpc: "2.0", id, result });
  }

  private requestHost(method: string, params: unknown, invocationId?: unknown, id?: string): string {
    const requestId = id ?? `child-${this.pid}-${this.nextChildRequest++}`;
    this.writeToManager({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
      ...(typeof invocationId === "string" ? { paperclipInvocationId: invocationId } : {}),
    });
    return requestId;
  }

  requestUnscopedHost(method: string, params: unknown, id: string): void {
    this.requestHost(method, params, undefined, id);
  }

  notifyUnscopedHost(method: string, params: unknown): void {
    this.writeToManager({ jsonrpc: "2.0", method, params });
  }

  private receive(message: JsonRecord): void {
    this.received.push(message);
    const id = String(message.id ?? "");
    const pending = this.pendingHostCalls.get(id);
    if (pending) {
      this.pendingHostCalls.delete(id);
      if (pending.kind === "startup-config") {
        this.startupConfig = message.result;
        this.respond(this.initializeId, { ok: true, supportedMethods: ["getData", "performAction"] });
      } else if (pending.kind === "get-data") {
        this.respond(pending.originalId, {
          pid: this.pid,
          initializedConfig: this.initializedConfig,
          startupConfig: this.startupConfig,
          hostConfig: message.result,
        });
      }
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    if (method === "initialize") {
      this.initializeId = message.id;
      const params = message.params as JsonRecord;
      this.initializedConfig = params.config;
      this.startupConfigRequestId = this.requestHost("config.get", {}, undefined, `startup-${this.pid}`);
      this.pendingHostCalls.set(this.startupConfigRequestId, { kind: "startup-config" });
    } else if (method === "getData") {
      const params = message.params as JsonRecord;
      const invocation = message.paperclipInvocation as JsonRecord | undefined;
      const invocationId = invocation?.id;
      this.writeToManager({
        jsonrpc: "2.0",
        method: "streams.emit",
        params: {
          companyId: params.companyId,
          channel: "workspace-owner-test",
          event: { type: "workspace-owner-test" },
        },
        ...(typeof invocationId === "string" ? { paperclipInvocationId: invocationId } : {}),
      });
      const hostCallId = this.requestHost("config.get", {}, invocationId);
      this.pendingHostCalls.set(hostCallId, { kind: "get-data", originalId: message.id });
    } else if (method === "performAction") {
      this.respond(message.id, { accepted: true });
    } else if (method === "health") {
      this.respond(message.id, { ok: true });
    } else if (method === "shutdown") {
      this.respond(message.id, {});
      if (this.holdShutdownClose) setImmediate(() => this.exitWithoutClose());
      else setImmediate(() => this.close());
    }
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    if (!this.exited) this.exitWithoutClose(code, signal);
    this.emit("close", code, signal);
  }

  private exitWithoutClose(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const PLUGIN_ID = "test.workspace-plugin";
const manifest: PaperclipPluginManifestV1 = {
  id: "test.workspace-plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Workspace test plugin",
  description: "Workspace test plugin",
  author: "SPS",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const children: FakeNdjsonWorker[] = [];

function workerOptions(config: Record<string, unknown>): WorkerStartOptions {
  return {
    entrypointPath: "fake-workspace-worker.cjs",
    manifest,
    config,
    instanceInfo: { instanceId: "host-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {
      "config.get": async (_params, context) => ({
        selectedWorkspace: context?.invocationScope?.companyId ?? "legacy-host",
        configLabel: config.label,
      }),
    },
    autoRestart: true,
  };
}

function workspaceAuthority(workspaceId: string): WorkerInvocationAuthority {
  return { boundWorkspaceId: workspaceId, assertCurrent: () => undefined };
}

function dataParams(workspaceId: string) {
  return { key: "overview", companyId: workspaceId, params: {}, renderEnvironment: null };
}

function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (condition()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for fake NDJSON worker"));
      setImmediate(poll);
    };
    poll();
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("PluginWorkerManager Workspace ownership", () => {
  beforeEach(() => {
    children.length = 0;
    childProcessMock.fork.mockReset();
    childProcessMock.fork.mockImplementation(() => {
      const child = new FakeNdjsonWorker(50_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    });
  });

  afterEach(() => vi.useRealTimers());

  it("keeps same-plugin workers, startup config, callbacks and stop ownership separate", async () => {
    const manager = createPluginWorkerManager();
    const streamsA = vi.fn();
    const handleA = await manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, {
      ...workerOptions({ label: "config-a" }),
      onStreamNotification: streamsA,
    });
    const handleB = await manager.startWorkspaceWorker(WORKSPACE_B, PLUGIN_ID, workerOptions({ label: "config-b" }));
    const hostHandle = await manager.startWorker(PLUGIN_ID, workerOptions({ label: "host-config" }));

    try {
      expect(new Set([handleA.diagnostics().pid, handleB.diagnostics().pid, hostHandle.diagnostics().pid]).size).toBe(3);
      expect(handleA.workspaceId).toBe(WORKSPACE_A);
      expect(handleB.diagnostics()).toMatchObject({ workspaceId: WORKSPACE_B, status: "running" });
      expect(manager.getWorker(PLUGIN_ID)).toBe(hostHandle);
      expect(manager.getWorkspaceWorker(WORKSPACE_A, PLUGIN_ID)).toBe(handleA);
      expect(manager.getWorkspaceWorker(WORKSPACE_B, PLUGIN_ID)).toBe(handleB);

      const childA = children.find((child) => child.pid === handleA.diagnostics().pid)!;
      const childB = children.find((child) => child.pid === handleB.diagnostics().pid)!;
      const resultA = await manager.callWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, "getData", dataParams(WORKSPACE_A), 1_000,
        workspaceAuthority(WORKSPACE_A));
      const resultB = await manager.callWorkspaceWorker(WORKSPACE_B, PLUGIN_ID, "getData", dataParams(WORKSPACE_B), 1_000,
        workspaceAuthority(WORKSPACE_B));
      expect(resultA).toMatchObject({ initializedConfig: { label: "config-a" }, startupConfig: { selectedWorkspace: WORKSPACE_A, configLabel: "config-a" } });
      expect(resultB).toMatchObject({ initializedConfig: { label: "config-b" }, startupConfig: { selectedWorkspace: WORKSPACE_B, configLabel: "config-b" } });
      expect(streamsA).toHaveBeenCalledWith("streams.emit", expect.objectContaining({ companyId: WORKSPACE_A }));

      const callsBeforeDenial = childA.received.filter((message) => message.method === "getData").length;
      await expect(manager.callWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, "getData", dataParams(WORKSPACE_B), 1_000,
        workspaceAuthority(WORKSPACE_A))).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      await expect(manager.callWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, "getData", dataParams(WORKSPACE_A), 1_000,
        workspaceAuthority(WORKSPACE_B))).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      await expect(manager.callWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, "getData", dataParams(WORKSPACE_A)))
        .rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      await expect(handleA.call("getData", dataParams(WORKSPACE_A))).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(childA.received.filter((message) => message.method === "getData")).toHaveLength(callsBeforeDenial);

      const gate = deferred<void>();
      const mutableAuthority = {
        boundWorkspaceId: WORKSPACE_A,
        assertCurrent: () => gate.promise,
      } as unknown as { boundWorkspaceId: string; assertCurrent: () => Promise<void> };
      const pinnedCall = manager.callWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, "getData", dataParams(WORKSPACE_A), 1_000,
        mutableAuthority as WorkerInvocationAuthority);
      mutableAuthority.boundWorkspaceId = WORKSPACE_B;
      gate.resolve();
      await expect(pinnedCall).resolves.toMatchObject({ startupConfig: { selectedWorkspace: WORKSPACE_A } });

      const callsBeforeUnscoped = childA.received.filter((message) => message.method === "getData").length;
      childA.requestUnscopedHost("config.get", {}, "unscoped-config");
      await waitFor(() => childA.received.some((message) => message.id === "unscoped-config"));
      expect(childA.received.find((message) => message.id === "unscoped-config")?.error)
        .toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      childA.notifyUnscopedHost("streams.emit", { companyId: WORKSPACE_A, channel: "unscoped", event: {} });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(streamsA).toHaveBeenCalledTimes(2);
      expect(childA.received.filter((message) => message.method === "getData")).toHaveLength(callsBeforeUnscoped);

      await manager.stopWorkspaceWorkers(WORKSPACE_A, PLUGIN_ID);
      expect(manager.getWorkspaceWorker(WORKSPACE_A, PLUGIN_ID)).toBeUndefined();
      expect(handleB.status).toBe("running");
      expect(hostHandle.status).toBe("running");
      await manager.stopWorker(PLUGIN_ID);
      expect(manager.getWorker(PLUGIN_ID)).toBeUndefined();
      expect(manager.getWorkspaceWorker(WORKSPACE_B, PLUGIN_ID)).toBeUndefined();
    } finally {
      await manager.shutdown();
    }
  });

  it("joins and closes every owner on global stopAll and shutdown", async () => {
    const manager = createPluginWorkerManager();
    const handleA = await manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, workerOptions({ label: "a" }));
    const handleB = await manager.startWorkspaceWorker(WORKSPACE_B, PLUGIN_ID, workerOptions({ label: "b" }));
    const hostHandle = await manager.startWorker(PLUGIN_ID, workerOptions({ label: "host" }));

    await manager.stopAll();
    expect(handleA.status).toBe("stopped");
    expect(handleB.status).toBe("stopped");
    expect(hostHandle.status).toBe("stopped");
    expect(manager.diagnostics()).toEqual([]);

    const nextA = await manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, workerOptions({ label: "next-a" }));
    const nextB = await manager.startWorkspaceWorker(WORKSPACE_B, PLUGIN_ID, workerOptions({ label: "next-b" }));
    await manager.shutdown();
    expect(nextA.status).toBe("stopped");
    expect(nextB.status).toBe("stopped");
  });

  it("retains a scoped owner and blocks replacement until exact stdio close", async () => {
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, workerOptions({ label: "a" }));
    const child = children[0]!;
    child.holdShutdownClose = true;
    const stopping = manager.stopWorkspaceWorkers(WORKSPACE_A, PLUGIN_ID);
    await waitFor(() => child.exited);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, workerOptions({ label: "replacement" })))
      .rejects.toThrow(/stopping/i);
    await expect(stopping).rejects.toThrow(/failed to stop/i);
    expect(manager.getWorkspaceWorker(WORKSPACE_A, PLUGIN_ID)).toBe(handle);
    expect(handle.diagnostics().pid).toBe(child.pid);

    child.close();
    expect(handle.status).toBe("stopped");
    // A failed close keeps the owner registered. Retry the exact stop to have
    // the manager confirm close and release that retained owner before reuse.
    await manager.stopWorkspaceWorkers(WORKSPACE_A, PLUGIN_ID);
    expect(manager.getWorkspaceWorker(WORKSPACE_A, PLUGIN_ID)).toBeUndefined();
    const replacement = await manager.startWorkspaceWorker(WORKSPACE_A, PLUGIN_ID, workerOptions({ label: "replacement" }));
    expect(replacement.diagnostics().pid).not.toBe(child.pid);
    await manager.shutdown();
  }, 8_000);
});
