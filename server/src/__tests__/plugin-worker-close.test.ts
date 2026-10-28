import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";

const childProcessMock = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  fork: childProcessMock.fork,
}));

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true);
  readonly receivedMessages: Record<string, unknown>[] = [];
  onRequest?: (method: string, request: Record<string, unknown>) => void;

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          const message = JSON.parse(chunk.toString()) as Record<string, unknown>;
          this.receivedMessages.push(message);
          const method = typeof message.method === "string" ? message.method : "";
          if (method === "initialize") {
            this.respond(message.id, { ok: true, supportedMethods: ["getData", "performAction"] });
          } else if (method === "shutdown") {
            this.respond(message.id, {});
          }
          this.onRequest?.(method, message);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  respond(id: unknown, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  request(id: string, method: string, params: unknown, invocationId?: string): void {
    this.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method, params,
      ...(invocationId ? { paperclipInvocationId: invocationId } : {}),
    })}\n`);
  }

  notify(method: string, params: unknown, invocationId?: string): void {
    this.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", method, params,
      ...(invocationId ? { paperclipInvocationId: invocationId } : {}),
    })}\n`);
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
}

const children: FakeChild[] = [];
const manifest: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "SPS",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function options(): WorkerStartOptions {
  return {
    entrypointPath: "fake-plugin-worker.cjs",
    manifest,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: { "companies.get": async (params) => ({ id: (params as { companyId: string }).companyId }) as never },
    autoRestart: true,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for the fake worker message");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function closeOnShutdown(child: FakeChild): void {
  child.onRequest = (method) => {
    if (method !== "shutdown") return;
    child.emit("exit", 0, null);
    child.close(0, null);
  };
}

describe("PluginWorkerManager child close lifecycle", () => {
  beforeEach(() => {
    children.length = 0;
    childProcessMock.fork.mockReset();
    childProcessMock.fork.mockImplementation(() => {
      const child = new FakeChild(40_000 + children.length);
      children.push(child);
      return child as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps an exited child retained and rejects stop until close is confirmed", async () => {
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker("test.plugin", options());
    const child = children[0]!;
    let shutdownObserved!: () => void;
    const shutdown = new Promise<void>((resolve) => { shutdownObserved = resolve; });
    child.onRequest = (method) => {
      if (method !== "shutdown") return;
      child.emit("exit", 0, null);
      shutdownObserved();
    };

    const stopping = handle.stop();
    await shutdown;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handle.status).toBe("stopping");
    expect(handle.diagnostics().pid).toBe(child.pid);
    await expect(manager.startWorker("test.plugin", options())).rejects.toThrow(/already registered/);

    await expect(stopping).rejects.toThrow(/did not confirm stdio closure/);
    expect(handle.status).toBe("stopping");
    expect(handle.diagnostics().pid).toBe(child.pid);
    expect(child.kill).not.toHaveBeenCalled();

    child.close();
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().pid).toBeNull();

    const replacement = await manager.startWorker("test.plugin", options());
    const replacementChild = children[1]!;
    replacementChild.onRequest = (method) => {
      if (method !== "shutdown") return;
      replacementChild.emit("exit", 0, null);
      replacementChild.close(0, null);
    };
    child.emit("error", new Error("late old-generation error"));
    child.emit("close", 0, null);
    expect(manager.getWorker("test.plugin")).toBe(replacement);
    expect(replacement.status).toBe("running");
    expect(replacement.diagnostics().pid).toBe(replacementChild.pid);
    await manager.shutdown();
  }, 8_000);

  it("accepts a buffered response after exit, rejects only unresolved calls at close, and blocks late host requests", async () => {
    const manager = createPluginWorkerManager();
    const hostCall = vi.fn(async (params: unknown) => ({ company: (params as { companyId: string }).companyId }));
    const handle = await manager.startWorker("test.plugin", {
      ...options(), autoRestart: false, hostHandlers: { "companies.get": hostCall },
    });
    const child = children[0]!;
    const terminalResponse = vi.fn();
    const terminalUnresolved = vi.fn();
    let responseGuardStarted!: () => void;
    let releaseResponseGuard!: () => void;
    const responseGuardReady = new Promise<void>((resolve) => { responseGuardStarted = resolve; });
    const responseGuardGate = new Promise<void>((resolve) => { releaseResponseGuard = resolve; });
    let responseGuardTimer: ReturnType<typeof setTimeout> | undefined;
    const responseGuardTimeout = new Promise<never>((_resolve, reject) => {
      responseGuardTimer = setTimeout(() => reject(new Error(`response authority checks reached ${authorityChecks}`)), 2_000);
    });
    let authorityChecks = 0;
    const callIds = new Map<string, unknown>();
    child.onRequest = (method, request) => {
      if (method === "getData" || method === "performAction") callIds.set(method, request.id);
    };

    const responseCall = handle.call("getData", { key: "data", companyId: "workspace-a", params: {} }, undefined,
      { assertCurrent: async () => {
        authorityChecks++;
        if (authorityChecks === 2) { responseGuardStarted(); await responseGuardGate; }
      }, onTerminal: terminalResponse });
    const unresolvedCall = handle.call("performAction", {
      key: "action", companyId: "workspace-a", params: {}, actorContext: {
        type: "user", userId: "fixture-user", agentId: null, runId: null, companyId: "workspace-a",
      },
    }, undefined, { assertCurrent: () => undefined, onTerminal: terminalUnresolved });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(callIds.size).toBe(2);

    const exits: Array<{ pluginId: string; code: number | null; signal: NodeJS.Signals | null }> = [];
    const crashes: unknown[] = [];
    handle.on("exit", (event) => exits.push(event));
    handle.on("crash", (event) => crashes.push(event));
    child.emit("error", new Error("synthetic child error before exit"));
    child.emit("exit", 1, null);
    expect(exits).toHaveLength(1);
    expect(crashes).toHaveLength(0);
    expect(handle.status).toBe("crashed");
    expect(handle.diagnostics().pid).toBe(child.pid);

    child.respond(callIds.get("getData"), { ok: true, companyId: "workspace-a" });
    await Promise.race([responseGuardReady, responseGuardTimeout]);
    if (responseGuardTimer) clearTimeout(responseGuardTimer);
    expect(terminalResponse).toHaveBeenCalledExactlyOnceWith("response");

    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "late-host-call", method: "companies.get", params: { companyId: "workspace-a" } })}\n`);
    await delay(10);
    expect(hostCall).not.toHaveBeenCalled();

    child.close(1, null);
    await expect(unresolvedCall).rejects.toThrow(/process exited/);
    expect(terminalUnresolved).toHaveBeenCalledExactlyOnceWith("worker_exit");
    releaseResponseGuard();
    await expect(responseCall).resolves.toEqual({ ok: true, companyId: "workspace-a" });
    expect(terminalResponse).toHaveBeenCalledExactlyOnceWith("response");
    expect(handle.diagnostics().pid).toBeNull();
    expect(handle.status).toBe("crashed");
    expect(crashes).toHaveLength(1);
    await manager.shutdown();
    if (responseGuardTimer) clearTimeout(responseGuardTimer);
  }, 8_000);

  it("does not route delayed old-generation host results or errors through the restarted handle", async () => {
    const manager = createPluginWorkerManager();
    const successStarted = deferred<void>();
    const failureStarted = deferred<void>();
    const successResult = deferred<unknown>();
    const failureResult = deferred<unknown>();
    const hostCall = vi.fn((params: unknown) => {
      const companyId = (params as { companyId: string }).companyId;
      if (companyId === "old-success") {
        successStarted.resolve();
        return successResult.promise;
      }
      if (companyId === "old-failure") {
        failureStarted.resolve();
        return failureResult.promise;
      }
      return Promise.resolve({ companyId, generation: "new" });
    });
    const handle = await manager.startWorker("test.plugin", {
      ...options(), autoRestart: false, hostHandlers: { "companies.get": hostCall as never },
    });
    const oldChild = children[0]!;

    oldChild.request("old-success-response", "companies.get", { companyId: "old-success" });
    oldChild.request("old-failure-response", "companies.get", { companyId: "old-failure" });
    await Promise.all([successStarted.promise, failureStarted.promise]);

    closeOnShutdown(oldChild);
    await handle.stop();
    expect(handle.status).toBe("stopped");
    expect(handle.diagnostics().pid).toBeNull();
    await handle.start();
    const newChild = children[1]!;

    newChild.request("new-response", "companies.get", { companyId: "new-workspace" });
    await waitFor(() => newChild.receivedMessages.some((message) => message.id === "new-response"));
    expect(newChild.receivedMessages.find((message) => message.id === "new-response"))
      .toMatchObject({ result: { companyId: "new-workspace", generation: "new" } });

    successResult.resolve({ companyId: "old-success", generation: "old" });
    failureResult.reject(new Error("old generation failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(newChild.receivedMessages.some((message) =>
      message.id === "old-success-response" || message.id === "old-failure-response"))
      .toBe(false);
    expect(oldChild.receivedMessages.some((message) =>
      message.id === "old-success-response" || message.id === "old-failure-response"))
      .toBe(false);

    closeOnShutdown(newChild);
    await handle.stop();
    await manager.shutdown();
  }, 8_000);

  it("drops a held old-generation streams.open after the same handle restarts", async () => {
    const manager = createPluginWorkerManager();
    const streamNotifications: Array<{ method: string; params: unknown }> = [];
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    let checks = 0;
    const contextCheckStarted = deferred<void>();
    const contextCheckGate = deferred<void>();
    const handle = await manager.startWorker("test.plugin", {
      ...options(),
      autoRestart: false,
      onStreamNotification: (method, params) => streamNotifications.push({ method, params }),
    });
    const oldChild = children[0]!;
    let invocationId = "";
    oldChild.onRequest = (method, request) => {
      if (method !== "getData") return;
      invocationId = ((request.paperclipInvocation as { id?: unknown } | undefined)?.id ?? "") as string;
    };

    const pendingCall = handle.call("getData", { key: "stream", companyId: workspaceId, params: {} }, undefined, {
      assertCurrent: async () => {
        checks++;
        if (checks === 2) {
          contextCheckStarted.resolve();
          await contextCheckGate.promise;
        }
      },
    });
    void pendingCall.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(invocationId).toMatch(/^sps-guarded:/);

    oldChild.notify("streams.open", { channel: "old-channel", companyId: workspaceId }, invocationId);
    await contextCheckStarted.promise;
    closeOnShutdown(oldChild);
    await handle.stop();
    await handle.start();
    const newChild = children[1]!;
    contextCheckGate.resolve();
    await delay(10);
    expect(streamNotifications).toEqual([]);
    expect(newChild.receivedMessages.some((message) => message.method === "streams.open" || message.method === "streams.close"))
      .toBe(false);

    closeOnShutdown(newChild);
    await handle.stop();
    expect(streamNotifications).toEqual([]);
    await manager.shutdown();
  }, 8_000);

  it("retains the spawn generation until close when an error arrives without exit", async () => {
    const manager = createPluginWorkerManager();
    const child = new FakeChild(41_000);
    let exitCount = 0;
    childProcessMock.fork.mockImplementationOnce(() => {
      children.push(child);
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("synthetic spawn failure"), { code: "ENOENT" }));
        child.close(null, null);
      });
      return child as unknown as ChildProcess;
    });
    child.on("exit", () => { exitCount++; });
    const start = manager.startWorker("test.plugin", { ...options(), autoRestart: false });
    const pendingHandle = manager.getWorker("test.plugin");
    const publicExits: unknown[] = [];
    pendingHandle?.on("exit", (event) => publicExits.push(event));
    await expect(start).rejects.toThrow(/failed to start|initialize/i);
    expect(exitCount).toBe(0);
    expect(publicExits).toHaveLength(0);
    const retained = manager.getWorker("test.plugin");
    expect(retained).toBeDefined();
    expect(retained!.diagnostics().pid).toBeNull();
    expect(retained!.status).not.toBe("running");
    await manager.shutdown();
  });
});
