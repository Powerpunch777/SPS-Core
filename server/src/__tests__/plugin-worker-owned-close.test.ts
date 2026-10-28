import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const adapter = vi.hoisted(() => ({ prepare: vi.fn(), spawn: vi.fn(), owner: vi.fn() }));
vi.mock("../services/plugin-worker-process.js", () => ({
  preparePluginWorkerProcess: adapter.prepare,
  spawnPluginWorkerProcess: adapter.spawn,
  getPluginWorkerProcessOwnership: adapter.owner,
}));
import { createPluginWorkerManager, type WorkerStartOptions } from "../services/plugin-worker-manager.js";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeHelper extends EventEmitter {
  pid = 9001;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  acknowledgeShutdown = false;
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const request = JSON.parse(String(chunk));
    if (request.method === "initialize" || request.method === "shutdown" && this.acknowledgeShutdown) {
      this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
    }
    callback();
  } });
  close() {
    this.emit("exit", 7, null);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 7, null);
  }
}
const options: WorkerStartOptions = {
  entrypointPath: "fixture-unused", manifest: { id: "example.owned", apiVersion: 1, version: "1.0.0", capabilities: [] } as unknown as PaperclipPluginManifestV1,
  config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1" }, apiVersion: 1, hostHandlers: {}, autoRestart: false,
};

describe("Plugin worker owned-scope closure", () => {
  it("escalates through the exact job owner without signalling the helper PID", async () => {
    const helper = new FakeHelper(), closure = deferred();
    helper.acknowledgeShutdown = true;
    const owner = { ready: Promise.resolve(), processId: () => 44, waitForClosure: () => closure.promise,
      hasUnconfirmed: () => false,
      terminate: vi.fn(async () => { helper.close(); closure.resolve(); await closure.promise; }),
    };
    adapter.prepare.mockReturnValue(undefined); adapter.spawn.mockReturnValue(helper);
    adapter.owner.mockImplementation(child => child === helper ? owner : null);
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker("example.owned", options);
    await manager.stopWorker("example.owned");
    expect(owner.terminate).toHaveBeenCalledOnce();
    expect(helper.kill).not.toHaveBeenCalled();
    expect(handle.status).toBe("stopped");
    expect(manager.getWorker("example.owned")).toBeUndefined();
    await manager.shutdown();
  });

  it("keeps the exact target and suppresses public exit until the job closure confirms", async () => {
    const helper = new FakeHelper(), closure = deferred();
    const owner = { ready: Promise.resolve(), processId: () => 42, waitForClosure: () => closure.promise,
      hasUnconfirmed: () => false, terminate: vi.fn(() => closure.promise) };
    adapter.prepare.mockReturnValue(undefined);
    adapter.spawn.mockReturnValue(helper);
    adapter.owner.mockImplementation(child => child === helper ? owner : null);
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker("example.owned", options);
    const exited = vi.fn(), crashed = vi.fn();
    handle.on("exit", exited); handle.on("crash", crashed);
    expect(handle.diagnostics().pid).toBe(42);
    helper.close();
    await turn();
    expect(exited).not.toHaveBeenCalled();
    expect(crashed).not.toHaveBeenCalled();
    expect(handle.diagnostics().pid).toBe(42);
    await expect(handle.start()).rejects.toThrow(/previous process/);
    closure.resolve();
    await turn();
    expect(exited).toHaveBeenCalledOnce();
    expect(crashed).toHaveBeenCalledOnce();
    expect(handle.diagnostics().pid).toBeNull();
    expect(helper.kill).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("retains a closed helper's unconfirmed target and refuses shutdown success or replacement", async () => {
    const helper = new FakeHelper(), closure = deferred();
    let failed = false;
    const owner = { ready: Promise.resolve(), processId: () => 43, waitForClosure: () => closure.promise,
      hasUnconfirmed: () => failed, terminate: vi.fn(() => closure.promise) };
    adapter.prepare.mockReturnValue(undefined); adapter.spawn.mockReturnValue(helper);
    adapter.owner.mockImplementation(child => child === helper ? owner : null);
    const manager = createPluginWorkerManager();
    const handle = await manager.startWorker("example.owned", options);
    const exited = vi.fn(), crashed = vi.fn();
    handle.on("exit", exited); handle.on("crash", crashed);
    helper.close(); failed = true; closure.reject(new Error("private helper failure"));
    await turn();
    expect(handle.diagnostics().pid).toBe(43);
    expect(exited).not.toHaveBeenCalled(); expect(crashed).not.toHaveBeenCalled();
    await expect(handle.start()).rejects.toThrow(/previous process/);
    await expect(manager.shutdown()).rejects.toThrow();
    expect(manager.getWorker("example.owned")).toBe(handle);
    expect(helper.kill).not.toHaveBeenCalled();
  }, 8_000);

  it("does not spawn after an admitted startup is stopped during helper preparation", async () => {
    const preparation = deferred();
    adapter.prepare.mockReturnValue(preparation.promise);
    adapter.spawn.mockClear(); adapter.owner.mockReturnValue(null);
    const manager = createPluginWorkerManager();
    const starting = manager.startWorker("example.owned", options);
    const rejected = expect(starting).rejects.toThrow(/stopped|stopping/);
    const stopping = manager.stopWorker("example.owned");
    preparation.resolve();
    await rejected; await stopping;
    expect(adapter.spawn).not.toHaveBeenCalled();
    await manager.shutdown();
  });
});
