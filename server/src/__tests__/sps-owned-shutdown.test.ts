import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachSpsOwnedShutdown } from "../services/sps-owned-shutdown.js";

const request = { v: 1, kind: "sps.owner-host.shutdown" };
const stopPipeToken = Buffer.from("sps.owner-host.shutdown/v1\n", "ascii");
const childFixture = fileURLToPath(new URL("./fixtures/sps-owned-shutdown-child.ts", import.meta.url));
const serverDirectory = fileURLToPath(new URL("../../..", import.meta.url));
class Parent extends EventEmitter { connected = true; send() {} }
const settle = () => new Promise(resolve => setImmediate(resolve));

function waitForChildMessage(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown) => {
      if (message !== "ready") return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Shutdown fixture exited before readiness (${code ?? signal}).`));
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for shutdown fixture readiness."));
    }, timeoutMs);
  });
}

function queueShutdownThenDisconnect(child: ChildProcess, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out queueing shutdown IPC.")), timeoutMs);
    try {
      child.send(request, error => {
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      child.disconnect();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for shutdown fixture exit."));
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForChildDisconnect(child: ChildProcess, timeoutMs: number) {
  if (!child.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("disconnect", onDisconnect);
      child.off("error", onError);
    };
    const onDisconnect = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for shutdown fixture IPC disconnect."));
    }, timeoutMs);
    child.once("disconnect", onDisconnect);
    child.once("error", onError);
  });
}

describe("owned Core shutdown", () => {
  it("accepts one exact direct-parent request and disposes without another callback", async () => {
    const parent = new Parent();
    let stops = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; });
    parent.emit("message", request); parent.emit("message", request);
    await settle();
    expect(stops).toBe(1);
    dispose(); parent.emit("message", request); await settle();
    expect(stops).toBe(1); expect(parent.listenerCount("message")).toBe(0);
  });
  it("ignores unknown, widened, accessor, disconnected and non-parent input", async () => {
    const parent = new Parent();
    let stops = 0, getters = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; });
    const accessor = { kind: request.kind };
    Object.defineProperty(accessor, "v", { enumerable: true, get() { getters++; return 1; } });
    for (const value of [null, [], {}, { ...request, path: "outside" }, { ...request, v: 2 },
      { ...request, kind: "other" }, accessor]) parent.emit("message", value);
    parent.connected = false; parent.emit("disconnect"); parent.emit("message", request); await settle();
    expect(stops).toBe(0); expect(getters).toBe(0); dispose();
    expect(attachSpsOwnedShutdown({}, async () => { stops++; })).toBeTypeOf("function");
  });
  it("accepts the last ordered message before disconnect but never messages after it", async () => {
    const parent = new Parent();
    let stops = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; });
    parent.connected = false;
    parent.emit("message", request);
    parent.emit("disconnect");
    parent.emit("message", request);
    await settle();
    expect(stops).toBe(1); expect(parent.listenerCount("message")).toBe(0); dispose();
  });
  it("contains a failed callback without treating a retry as a new shutdown", async () => {
    const parent = new Parent();
    let stops = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; throw new Error("fixture failure"); });
    parent.emit("message", request); await settle(); parent.emit("message", request); await settle();
    expect(stops).toBe(1); dispose();
  });

  it("keeps the independent stop pipe after IPC disconnect and accepts only the exact token at EOF", async () => {
    const parent = new Parent();
    const pipe = new PassThrough();
    let stops = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; }, pipe);

    parent.connected = false;
    parent.emit("disconnect");
    parent.emit("message", request);
    expect(pipe.listenerCount("data")).toBe(1);
    pipe.write(stopPipeToken.subarray(0, 9));
    await settle();
    expect(stops).toBe(0);
    pipe.end(stopPipeToken.subarray(9));
    await settle();
    expect(stops).toBe(1);
    dispose();
  });

  it("ignores malformed, oversized, errored, and disposed stop pipes", async () => {
    const rejectedInputs: Array<(pipe: PassThrough) => void> = [
      pipe => pipe.end(Buffer.from("sps.owner-host.shutdown/v1", "ascii")),
      pipe => pipe.end(Buffer.alloc(65, 0x61)),
      pipe => pipe.emit("error", new Error("fixture read failure")),
      pipe => {
        pipe.push(stopPipeToken);
        pipe.push(null);
      },
    ];

    for (const [index, rejectInput] of rejectedInputs.entries()) {
      const parent = new Parent();
      const pipe = new PassThrough();
      let stops = 0;
      const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; }, pipe);
      if (index === rejectedInputs.length - 1) dispose();
      rejectInput(pipe);
      await settle();
      expect(stops).toBe(0);
      expect(() => pipe.emit("error", new Error("late fixture read failure"))).not.toThrow();
      dispose();
    }
  });

  it("runs shutdown once when IPC and the stop pipe both request it", async () => {
    const parent = new Parent();
    const pipe = new PassThrough();
    let stops = 0;
    const dispose = attachSpsOwnedShutdown(parent, async () => { stops++; }, pipe);
    parent.emit("message", request);
    pipe.end(stopPipeToken);
    await settle();
    expect(stops).toBe(1);
    dispose();
  });

  it("processes a queued shutdown once and exits after parent disconnect", async () => {
    const child = fork(childFixture, [], {
      cwd: serverDirectory,
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });

    try {
      await waitForChildMessage(child, 10_000);
      expect(child.connected).toBe(true);
      await queueShutdownThenDisconnect(child, 5_000);
      await expect(waitForChildExit(child, 5_000)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 2_000);
      }
    }
  }, 25_000);

  it("accepts the stop-only fd 4 token after the real parent IPC channel disconnects", async () => {
    const child = fork(childFixture, ["--pipe"], {
      cwd: serverDirectory,
      env: { ...process.env, SPS_DESKTOP_OWNED_SHUTDOWN_PIPE: "1" },
      execArgv: ["--import", import.meta.resolve("tsx")],
      stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
      windowsHide: true,
    });

    try {
      await waitForChildMessage(child, 10_000);
      expect(child.connected).toBe(true);
      const disconnected = waitForChildDisconnect(child, 5_000);
      child.disconnect();
      await disconnected;

      const stopPipe = child.stdio[4] as Writable | null;
      if (!stopPipe) throw new Error("Shutdown fixture fd 4 pipe was not available.");
      await new Promise<void>((resolve, reject) => {
        stopPipe.once("error", reject);
        stopPipe.end(stopPipeToken, () => {
          stopPipe.removeListener("error", reject);
          resolve();
        });
      });
      await expect(waitForChildExit(child, 5_000)).resolves.toEqual({ code: 0, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child, 2_000);
      }
    }
  }, 25_000);
});
