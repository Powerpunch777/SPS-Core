import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-stdio-eof.mjs");
const READY_MARKER = "SPS_TEST_SDK_WORKER_READY";

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error(`SDK worker did not become ready: ${stderr}`)), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
      if (stderr.includes(READY_MARKER)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`SDK worker exited before readiness (code=${code}, signal=${signal})`));

    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForClose(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
}

async function stopOwnedChild(
  child: ChildProcess,
  closePromise: Promise<[number | null, NodeJS.Signals | null]>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {
    await waitForCloseWithin(closePromise, 2_000);
  } catch {
    throw new Error("SDK worker owned child did not confirm close during cleanup");
  }
}

function waitForCloseWithin(
  closePromise: Promise<[number | null, NodeJS.Signals | null]>,
  timeoutMs: number,
): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("SDK worker did not close after stdin EOF")), timeoutMs);
    closePromise.then(
      value => { clearTimeout(timeout); resolve(value); },
      error => { clearTimeout(timeout); reject(error); },
    );
  });
}

describe("SDK worker stdio owner closure", () => {
  it("exits when its owner closes the NDJSON stdin pipe", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
    if (process.platform === "win32") {
      env.SYSTEMROOT = process.env.SYSTEMROOT ?? "C:\\Windows";
      env.WINDIR = process.env.WINDIR ?? env.SYSTEMROOT;
    }
    const child = fork(FIXTURE, [], {
      cwd: path.resolve(path.dirname(FIXTURE), "../../.."),
      env,
      execArgv: ["--import", "tsx"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const closePromise = waitForClose(child);
    void closePromise.catch(() => undefined);
    child.stdout?.resume();

    try {
      await waitForReady(child);
      child.stdin?.end();
      const [code, signal] = await waitForCloseWithin(closePromise, 5_000);
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      await stopOwnedChild(child, closePromise);
    }
  }, 12_000);
});
