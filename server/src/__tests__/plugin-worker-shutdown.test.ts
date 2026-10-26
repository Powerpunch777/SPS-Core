import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createPluginWorkerManager,
  type WorkerStartOptions,
} from "../services/plugin-worker-manager.js";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-shutdown.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
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

function createTempDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), "plugin-worker-shutdown-"));
}

function createOptions(
  directory: string,
  env: Record<string, string> = {},
): WorkerStartOptions {
  return {
    entrypointPath: FIXTURE_PATH,
    manifest: TEST_MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: {},
    env: {
      SPS_TEST_PID_FILE: path.join(directory, "pids.txt"),
      ...env,
    },
  };
}

function readPids(directory: string): number[] {
  const pidFile = path.join(directory, "pids.txt");
  if (!existsSync(pidFile)) return [];
  return readFileSync(pidFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(10);
  }
  throw new Error(`Worker process ${pid} did not exit`);
}

describe("PluginWorkerManager shutdown", () => {
  it("shares stop and shutdown promises and waits for child exit beyond the RPC response", async () => {
    const directory = createTempDirectory();
    const manager = createPluginWorkerManager();

    try {
      const handle = await manager.startWorker(
        "test.plugin",
        createOptions(directory, {
          SPS_TEST_SHUTDOWN_MARKER: path.join(directory, "shutdown.txt"),
          SPS_TEST_SHUTDOWN_EXIT_DELAY_MS: "350",
        }),
      );
      const pid = handle.diagnostics().pid;
      expect(pid).not.toBeNull();

      const stopPromise = handle.stop();
      expect(handle.stop()).toBe(stopPromise);

      const shutdownPromise = manager.shutdown();
      expect(manager.shutdown()).toBe(shutdownPromise);
      let shutdownSettled = false;
      void shutdownPromise.then(
        () => { shutdownSettled = true; },
        () => { shutdownSettled = true; },
      );

      await waitForFile(path.join(directory, "shutdown.txt"));
      await delay(25);
      expect(shutdownSettled).toBe(false);
      expect(isProcessAlive(pid!)).toBe(true);
      await expect(handle.start()).rejects.toThrow("while it is stopping");
      expect(readPids(directory)).toHaveLength(1);

      await Promise.all([stopPromise, shutdownPromise]);
      expect(handle.status).toBe("stopped");
      expect(handle.diagnostics().pid).toBeNull();
      await waitForProcessExit(pid!);
      expect(manager.getWorker("test.plugin")).toBe(handle);
      expect(manager.isRunning("test.plugin")).toBe(false);
      await expect(handle.start()).rejects.toThrow("manager is shut down");
      await expect(handle.restart()).rejects.toThrow("manager is shut down");
      expect(readPids(directory)).toHaveLength(1);
    } finally {
      await manager.shutdown().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes synchronously, joins an in-flight initialize, and rejects later starts", async () => {
    const directory = createTempDirectory();
    const manager = createPluginWorkerManager();

    try {
      const startPromise = manager.startWorker(
        "test.plugin",
        createOptions(directory, {
          SPS_TEST_INITIALIZE_MARKER: path.join(directory, "initialize.txt"),
          SPS_TEST_INITIALIZE_DELAY_MS: "300",
        }),
      );
      const shutdownPromise = manager.shutdown();
      expect(manager.shutdown()).toBe(shutdownPromise);

      await expect(
        manager.startWorker("test.plugin", createOptions(directory)),
      ).rejects.toThrow("Plugin worker manager is shut down");
      await waitForFile(path.join(directory, "initialize.txt"));

      let shutdownSettled = false;
      void shutdownPromise.then(
        () => { shutdownSettled = true; },
        () => { shutdownSettled = true; },
      );
      await delay(30);
      expect(shutdownSettled).toBe(false);
      expect(readPids(directory)).toHaveLength(1);

      const handle = await startPromise;
      await shutdownPromise;
      expect(handle.status).toBe("stopped");
      expect(readPids(directory)).toHaveLength(1);
      await waitForProcessExit(readPids(directory)[0]);
      await expect(
        manager.startWorker("test.plugin", createOptions(directory)),
      ).rejects.toThrow("Plugin worker manager is shut down");
    } finally {
      await manager.shutdown().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not retry a worker whose process exits during initialize", async () => {
    const directory = createTempDirectory();
    const manager = createPluginWorkerManager();

    try {
      await expect(
        manager.startWorker(
          "test.plugin",
          createOptions(directory, {
            SPS_TEST_INITIALIZE_MARKER: path.join(directory, "initialize.txt"),
            SPS_TEST_EXIT_DURING_INITIALIZE: "1",
          }),
        ),
      ).rejects.toThrow("Worker initialize failed");

      await delay(1_400);
      expect(readPids(directory)).toHaveLength(1);
      expect(manager.getWorker("test.plugin")?.status).toBe("crashed");

      await manager.shutdown();
      expect(manager.getWorker("test.plugin")?.diagnostics()).toMatchObject({
        status: "stopped",
        pid: null,
      });
    } finally {
      await manager.shutdown().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps stopAll reusable", async () => {
    const directory = createTempDirectory();
    const manager = createPluginWorkerManager();

    try {
      const first = await manager.startWorker("test.plugin", createOptions(directory));
      const firstPid = first.diagnostics().pid;
      await manager.stopAll();
      expect(first.status).toBe("stopped");
      expect(manager.getWorker("test.plugin")).toBeUndefined();
      expect(isProcessAlive(firstPid!)).toBe(false);

      const second = await manager.startWorker("test.plugin", createOptions(directory));
      const secondPid = second.diagnostics().pid;
      expect(secondPid).not.toBe(firstPid);
      await manager.shutdown();
      expect(second.status).toBe("stopped");
      expect(readPids(directory)).toHaveLength(2);
    } finally {
      await manager.shutdown().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
