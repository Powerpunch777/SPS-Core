import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginWorkerProcessAdapter,
  type PluginWorkerProcessOptions,
} from "../services/plugin-worker-process.js";
import type {
  WindowsJobSupervisorInvocation,
  WindowsSupervisedProcess,
} from "../native-runtime/windows-job-supervisor/supervisor.mjs";
import { assertWindowsJobSupervisorAvailable } from "../native-runtime/windows-job-supervisor/supervisor.mjs";

function fakeChild(extra: Record<string, unknown> = {}): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
    ...extra,
  }) as unknown as ChildProcess;
}

const options: PluginWorkerProcessOptions = {
  env: { PAPERCLIP_PLUGIN_ID: "plugin-a", NODE_ENV: "test" },
  execArgv: ["--enable-source-maps"],
};

describe("plugin worker process adapter", () => {
  it("requires an explicit Core-owned helper path for transport availability", async () => {
    await expect(assertWindowsJobSupervisorAvailable({ platform: "win32" })).rejects.toThrow(/helper is unavailable/);
    await expect(assertWindowsJobSupervisorAvailable({ platform: "win32", helperPath: "relative.exe" })).rejects.toThrow(/helper is unavailable/);
    const access = vi.fn(async () => {});
    await expect(assertWindowsJobSupervisorAvailable({ platform: "win32", helperPath: "C:\\private\\helper.exe", access })).resolves.toBe("C:\\private\\helper.exe");
    expect(access).toHaveBeenCalledExactlyOnceWith("C:\\private\\helper.exe");
  });

  it("preserves case-sensitive POSIX environment names", () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const adapter = createPluginWorkerProcessAdapter({ platform: "linux", fork: fork as never });
    expect(adapter.spawnPluginWorkerProcess("/plugins/entry.js", { ...options, env: { PATH: "one", Path: "two" } })).toBe(child);
    expect(fork.mock.calls[0]?.[2].env).toEqual({ PATH: "one", Path: "two" });
  });

  it("keeps POSIX fork synchronous and unwrapped", () => {
    const child = fakeChild();
    const fork = vi.fn(() => child);
    const spawnWindows = vi.fn();
    const adapter = createPluginWorkerProcessAdapter({
      platform: "linux",
      fork: fork as never,
      spawnWindows: spawnWindows as never,
    });

    expect(adapter.preparePluginWorkerProcess()).toBeUndefined();
    expect(adapter.spawnPluginWorkerProcess("/plugins/entry.js", options)).toBe(child);
    expect(fork).toHaveBeenCalledWith("/plugins/entry.js", [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: ["--enable-source-maps"],
      env: { PAPERCLIP_PLUGIN_ID: "plugin-a", NODE_ENV: "test" },
    });
    expect(adapter.getPluginWorkerProcessOwnership(child)).toBeNull();
    expect(spawnWindows).not.toHaveBeenCalled();
  });

  it("fails closed on Windows until prepared and rejects case-folded environment duplicates", () => {
    const fork = vi.fn();
    const spawnWindows = vi.fn();
    const adapter = createPluginWorkerProcessAdapter({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd: () => "C:\\plugins",
      windowsHelperPath: () => "C:\\private\\supervisor.exe",
      fork: fork as never,
      spawnWindows: spawnWindows as never,
      prepareWindowsHelper: () => undefined,
    });

    expect(() => adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", options)).toThrow(/not prepared/);
    adapter.preparePluginWorkerProcess();
    expect(() => adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", {
      ...options,
      env: { Path: "one", PATH: "two" },
    })).toThrow(/Invalid plugin worker process invocation/);
    expect(fork).not.toHaveBeenCalled();
    expect(spawnWindows).not.toHaveBeenCalled();
  });

  it("uses the exact prepared helper and separates helper PID from worker PID", async () => {
    let ownershipConfirmed = false;
    const waitForOwnedJobTermination = vi.fn(async () => {
      ownershipConfirmed = true;
      return { type: "cancelled" };
    });
    const terminateOwnedJob = vi.fn(async () => ({ type: "cancelled" }));
    const child = Object.assign(fakeChild({ pid: 42 }), {
      pid: 42,
      supervisorReady: Promise.resolve(1234),
      terminateOwnedJob,
      waitForOwnedJobTermination,
      hasUnconfirmedOwnedJobTermination: () => !ownershipConfirmed,
    }) as unknown as WindowsSupervisedProcess;
    const prepare = vi.fn(() => undefined);
    const spawnWindows = vi.fn((_invocation: WindowsJobSupervisorInvocation) => child);
    const adapter = createPluginWorkerProcessAdapter({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd: () => "C:\\plugins",
      windowsHelperPath: () => "C:\\private\\supervisor.exe",
      fork: vi.fn() as never,
      prepareWindowsHelper: prepare,
      spawnWindows: spawnWindows as never,
    });

    adapter.preparePluginWorkerProcess();
    const workerChild = adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", options);
    expect(workerChild.pid).toBe(42);
    const invocation = spawnWindows.mock.calls[0]?.[0];
    expect(invocation).toEqual({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      cwd: "C:\\plugins",
      args: ["--enable-source-maps", "C:\\plugins\\entry.js"],
      env: {
        PAPERCLIP_PLUGIN_ID: "plugin-a",
        NODE_ENV: "test",
        SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows",
        WINDIR: process.env.WINDIR ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      },
    });
    const owner = adapter.getPluginWorkerProcessOwnership(workerChild);
    expect(owner).not.toBeNull();
    await owner?.ready;
    expect(owner?.processId()).toBe(1234);
    expect(owner?.hasUnconfirmed()).toBe(true);
    await owner?.terminate();
    expect(terminateOwnedJob).toHaveBeenCalledTimes(1);

    const closure = owner?.waitForClosure();
    await Promise.resolve();
    expect(waitForOwnedJobTermination).toHaveBeenCalledTimes(1);
    (workerChild as unknown as EventEmitter).emit("close", 0, null);
    await closure;
    expect(owner?.processId()).toBeNull();
    expect(owner?.hasUnconfirmed()).toBe(false);
  });

  it("shares an asynchronous Windows preparation and rejects an unprepared launch", async () => {
    let finishPreparation!: () => void;
    const prepareWindowsHelper = vi.fn(() => new Promise<void>(resolve => { finishPreparation = resolve; }));
    const child = fakeChild();
    const spawnWindows = vi.fn(() => child as never);
    const adapter = createPluginWorkerProcessAdapter({
      platform: "win32",
      execPath: "C:\\node.exe",
      cwd: () => "C:\\plugins",
      windowsHelperPath: () => "C:\\private\\supervisor.exe",
      prepareWindowsHelper,
      spawnWindows: spawnWindows as never,
    });

    const first = adapter.preparePluginWorkerProcess();
    const second = adapter.preparePluginWorkerProcess();
    expect(first).toBeInstanceOf(Promise);
    expect(second).toBe(first);
    expect(prepareWindowsHelper).toHaveBeenCalledTimes(1);
    expect(() => adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", options)).toThrow(/not prepared/);
    finishPreparation();
    await Promise.all([first, second]);
    expect(adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", options)).toBe(child);
    expect(spawnWindows).toHaveBeenCalledTimes(1);
  });
});
