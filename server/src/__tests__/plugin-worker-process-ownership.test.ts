import { createServer, type AddressInfo, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const observed = vi.hoisted(() => ({ children: [] as ChildProcess[] }));

// Preserve the real Windows job-backed adapter and only observe the exact
// child handles it creates. This test intentionally does not mock fork/spawn.
vi.mock("../services/plugin-worker-process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-worker-process.js")>();
  return {
    ...actual,
    spawnPluginWorkerProcess: (...args: Parameters<typeof actual.spawnPluginWorkerProcess>) => {
      const child = actual.spawnPluginWorkerProcess(...args);
      observed.children.push(child);
      return child;
    },
  };
});

import { createPluginWorkerManager, type PluginWorkerHandle, type WorkerStartOptions } from "../services/plugin-worker-manager.js";
import { getPluginWorkerProcessOwnership } from "../services/plugin-worker-process.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-descendant.mjs");
const pluginId = "worker.descendant.test";
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const manifest: PaperclipPluginManifestV1 = {
  id: pluginId,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Process ownership fixture",
  description: "Test fixture",
  author: "SPS",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function createHeartbeatServer() {
  const counts = new Map<string, number>();
  const sockets = new Set<Socket>();
  const waiters = new Map<string, Set<() => void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const nonce = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        counts.set(nonce, (counts.get(nonce) ?? 0) + 1);
        for (const notify of waiters.get(nonce) ?? []) notify();
      }
    });
  });

  return new Promise<{
    port: number;
    count(nonce: string): number;
    waitForHeartbeat(nonce: string, after?: number): Promise<void>;
    close(): Promise<void>;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        count: nonce => counts.get(nonce) ?? 0,
        async waitForHeartbeat(nonce, after = 0) {
          if ((counts.get(nonce) ?? 0) > after) return;
          await new Promise<void>((resolveWait, rejectWait) => {
            const listeners = waiters.get(nonce) ?? new Set<() => void>();
            waiters.set(nonce, listeners);
            let timeout: ReturnType<typeof setTimeout>;
            const notify = () => {
              if ((counts.get(nonce) ?? 0) <= after) return;
              clearTimeout(timeout);
              listeners.delete(notify);
              if (listeners.size === 0) waiters.delete(nonce);
              resolveWait();
            };
            timeout = setTimeout(() => {
              listeners.delete(notify);
              if (listeners.size === 0) waiters.delete(nonce);
              rejectWait(new Error("The owned descendant heartbeat was not observed."));
            }, 5_000);
            listeners.add(notify);
          });
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise<void>((resolveClose, rejectClose) => {
            server.close(error => error ? rejectClose(error) : resolveClose());
          });
        },
      });
    });
  });
}

function workerOptions(port: number, nonce: string): WorkerStartOptions {
  return {
    entrypointPath: fixturePath,
    manifest,
    config: {},
    instanceInfo: { instanceId: "ownership-test", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    autoRestart: false,
    rpcTimeoutMs: 2_000,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
      WINDIR: process.env.WINDIR || process.env.SYSTEMROOT || "C:\\Windows",
      SPS_TEST_HEARTBEAT_PORT: String(port),
      SPS_TEST_HEARTBEAT_NONCE: nonce,
    },
  };
}

async function stopWithin<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned worker process-tree close did not settle.")), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("PluginWorkerManager process-tree ownership", () => {
  afterEach(() => {
    observed.children.length = 0;
  });

  it.skipIf(process.platform !== "win32")("closes only the selected Workspace worker tree and leaves another worker callable", async () => {
    const heartbeat = await createHeartbeatServer();
    const nonceA = `workspace-a-${randomUUID()}`;
    const nonceB = `workspace-b-${randomUUID()}`;
    const manager = createPluginWorkerManager();
    let handleA: PluginWorkerHandle | undefined;
    let handleB: PluginWorkerHandle | undefined;
    let ownerA: ReturnType<typeof getPluginWorkerProcessOwnership> = null;
    let ownerB: ReturnType<typeof getPluginWorkerProcessOwnership> = null;

    try {
      handleA = await manager.startWorkspaceWorker(workspaceA, pluginId, workerOptions(heartbeat.port, nonceA));
      handleB = await manager.startWorkspaceWorker(workspaceB, pluginId, workerOptions(heartbeat.port, nonceB));
      expect(observed.children).toHaveLength(2);
      ownerA = getPluginWorkerProcessOwnership(observed.children[0]);
      ownerB = getPluginWorkerProcessOwnership(observed.children[1]);
      expect(ownerA).not.toBeNull();
      expect(ownerB).not.toBeNull();
      await ownerA!.ready;
      await ownerB!.ready;

      await heartbeat.waitForHeartbeat(nonceA);
      await heartbeat.waitForHeartbeat(nonceB);
      const unrelatedHeartbeatCount = heartbeat.count(nonceB);

      await stopWithin(manager.stopWorkspaceWorkers(workspaceA, pluginId));
      await stopWithin(ownerA!.waitForClosure());
      expect(ownerA!.hasUnconfirmed()).toBe(false);
      expect(ownerA!.processId()).toBeNull();
      expect(handleA.status).toBe("stopped");

      await expect(handleB.call("health", {} as never, 2_000)).resolves.toMatchObject({ alive: true });
      await heartbeat.waitForHeartbeat(nonceB, unrelatedHeartbeatCount);
      expect(ownerB!.hasUnconfirmed()).toBe(false);

      let crashObservedAfterOwnedClose = false;
      const crashObserved = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Crash event was not emitted after process-tree closure.")), 8_000);
        const onCrash = () => {
          clearTimeout(timeout);
          crashObservedAfterOwnedClose = !ownerB!.hasUnconfirmed() && ownerB!.processId() === null;
          handleB!.off("crash", onCrash);
          resolve();
        };
        handleB!.on("crash", onCrash);
      });
      void crashObserved.catch(() => undefined);
      await expect(handleB.call("health", { crash: true } as never, 2_000)).resolves.toMatchObject({ alive: true });
      await stopWithin(crashObserved);
      expect(crashObservedAfterOwnedClose).toBe(true);
      await stopWithin(ownerB!.waitForClosure());
      expect(ownerB!.hasUnconfirmed()).toBe(false);
      expect(ownerB!.processId()).toBeNull();
    } finally {
      let shutdownFailure: unknown;
      try {
        await stopWithin(manager.shutdown());
      } catch (error) {
        shutdownFailure = error;
      }
      await heartbeat.close();
      if (ownerA) await stopWithin(ownerA.waitForClosure());
      if (ownerB) await stopWithin(ownerB.waitForClosure());
      if (shutdownFailure) throw shutdownFailure;
    }
  }, 45_000);
});
