import { randomUUID } from "node:crypto";
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { lstat, mkdtemp, mkdir, realpath, rm, symlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-parent-loss.mjs");
const observerSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "process-handle-observer.cs");

type DirectoryIdentity = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.isDirectory() && !left.isSymbolicLink()
    && right.isDirectory() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

type FixtureReady = {
  type: "ready";
  nonce: string;
  corePid: number;
  helperPid: number;
  workerPid: number;
  descendantPid: number;
};
type FixtureVerified = Omit<FixtureReady, "type"> & { type: "verified"; helperAlive: boolean };

function createHeartbeatServer() {
  const sockets = new Set<Socket>();
  const nonceBySocket = new Map<Socket, string>();
  const waiters = new Map<string, Set<() => void>>();
  const disconnectWaiters = new Map<string, Set<() => void>>();
  const counts = new Map<string, number>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("error", () => undefined);
    socket.on("data", chunk => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const nonce = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        nonceBySocket.set(socket, nonce);
        counts.set(nonce, (counts.get(nonce) ?? 0) + 1);
        for (const wake of waiters.get(nonce) ?? []) wake();
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      const nonce = nonceBySocket.get(socket);
      nonceBySocket.delete(socket);
      if (nonce) for (const wake of disconnectWaiters.get(nonce) ?? []) wake();
    });
  });

  return new Promise<{
    port: number;
    waitForHeartbeat(nonce: string): Promise<void>;
    isConnected(nonce: string): boolean;
    waitForDisconnect(nonce: string): Promise<void>;
    close(): Promise<void>;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const wait = (nonce: string, disconnect: boolean) => new Promise<void>((resolveWait, rejectWait) => {
        const alreadyObserved = disconnect
          ? !Array.from(nonceBySocket.values()).includes(nonce) && (counts.get(nonce) ?? 0) > 0
          : (counts.get(nonce) ?? 0) > 0;
        if (alreadyObserved) return resolveWait();
        const map = disconnect ? disconnectWaiters : waiters;
        const listeners = map.get(nonce) ?? new Set<() => void>();
        map.set(nonce, listeners);
        let timeout: ReturnType<typeof setTimeout>;
        const wake = () => {
          if (disconnect ? Array.from(nonceBySocket.values()).includes(nonce) : (counts.get(nonce) ?? 0) === 0) return;
          clearTimeout(timeout);
          listeners.delete(wake);
          if (listeners.size === 0) map.delete(nonce);
          resolveWait();
        };
        timeout = setTimeout(() => {
          listeners.delete(wake);
          if (listeners.size === 0) map.delete(nonce);
          rejectWait(new Error(disconnect ? "Descendant heartbeat connection did not close." : "Descendant heartbeat was not observed."));
        }, 8_000);
        listeners.add(wake);
      });
      resolve({
        port: address.port,
        waitForHeartbeat: nonce => wait(nonce, false),
        isConnected: nonce => Array.from(sockets).some(socket => !socket.destroyed && socket.writable && nonceBySocket.get(socket) === nonce),
        waitForDisconnect: nonce => wait(nonce, true),
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

function waitForFixtureReady(child: ChildProcess, nonce: string, getStderr: () => string): Promise<FixtureReady> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Core parent-loss fixture did not become ready.")), 30_000);
    const finish = (error?: Error, value?: FixtureReady) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(value!);
    };
    const onMessage = (message: unknown) => {
      const value = message as Partial<FixtureReady>;
      if (!value || value.type !== "ready" || value.nonce !== nonce) return finish(new Error("Core fixture returned an unauthenticated readiness message."));
      if (![value.corePid, value.helperPid, value.workerPid, value.descendantPid].every(pid => Number.isSafeInteger(pid) && (pid as number) > 0)) {
        return finish(new Error("Core fixture returned invalid process identity metadata."));
      }
      finish(undefined, value as FixtureReady);
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null) => finish(new Error(`Core fixture closed before readiness (${code}): ${getStderr()}`));
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForFixtureVerified(child: ChildProcess, nonce: string): Promise<FixtureVerified> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Core owner did not confirm live process identities.")), 5_000);
    const finish = (error?: Error, value?: FixtureVerified) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(value!);
    };
    const onMessage = (message: unknown) => {
      const value = message as Partial<FixtureVerified>;
      if (!value || value.nonce !== nonce) return;
      if (value.type !== "verified") return finish(new Error("Core owner failed its live identity recheck."));
      if (![value.corePid, value.helperPid, value.workerPid, value.descendantPid].every(pid => Number.isSafeInteger(pid) && (pid as number) > 0)
        || value.helperAlive !== true) {
        return finish(new Error("Core owner did not confirm its helper and worker identities remain live."));
      }
      finish(undefined, value as FixtureVerified);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Core owner closed during live identity recheck."));
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForText(child: ChildProcess, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => finish(new Error(`Process observer did not report ${text}.`)), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-128);
      if (buffered.split(/\r?\n/).includes(text)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null) => finish(new Error(`Process observer closed before ${text} (${code}).`));
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function observeClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("close", () => resolve());
    child.once("error", reject);
  });
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}

function compileObserver(root: string): string {
  const windowsRoot = process.env.WINDIR || process.env.SYSTEMROOT || "C:\\Windows";
  const compiler = path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const executable = path.join(root, "ProcessHandleObserver.exe");
  execFileSync(compiler, ["/nologo", "/optimize+", "/platform:x64", `/out:${executable}`, observerSource], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16_384,
  });
  return executable;
}

describe("Windows plugin worker parent-loss ownership", () => {
  it.skipIf(process.platform !== "win32")("closes the exact worker tree after its Core owner disappears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sps-parent-loss-test-"));
    const ownedParent = await realpath(path.dirname(root));
    const ownedRootPath = await realpath(root);
    const ownedRootIdentity = await lstat(root, { bigint: true });
    const canonicalTempRoot = path.join(root, "canonical-temp");
    const tempJunction = path.join(root, "redirected-temp");
    await mkdir(canonicalTempRoot);
    const canonicalTempIdentity = await lstat(canonicalTempRoot, { bigint: true });
    await symlink(canonicalTempRoot, tempJunction, "junction");
    const canonicalRoot = await realpath(canonicalTempRoot);
    const junctionTarget = await realpath(tempJunction);
    if (canonicalRoot !== junctionTarget || !canonicalRoot.startsWith(ownedRootPath + path.sep)) {
      throw new Error("Test TEMP junction did not resolve inside its owned root.");
    }

    const nonce = randomUUID();
    const heartbeatNonce = `parent-loss-${nonce}`;
    const observerExe = compileObserver(root);
    const heartbeat = await createHeartbeatServer();
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "test",
      SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
      WINDIR: process.env.WINDIR || process.env.SYSTEMROOT || "C:\\Windows",
      TEMP: tempJunction,
      TMP: tempJunction,
      SPS_TEST_PARENT_LOSS_NONCE: nonce,
      SPS_TEST_HEARTBEAT_PORT: String(heartbeat.port),
      SPS_TEST_HEARTBEAT_NONCE: heartbeatNonce,
    };
    if (process.env.PROGRAMFILES) environment.PROGRAMFILES = process.env.PROGRAMFILES;

    const core = fork(fixturePath, [], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      env: environment,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    let coreStderr = "";
    core.stderr?.on("data", chunk => { coreStderr = `${coreStderr}${chunk.toString()}`.slice(-2_000); });
    const coreClose = observeClose(core);
    void coreClose.catch(() => undefined);
    let observer: ChildProcess | undefined;
    let observerClose: Promise<void> | undefined;
    let allExactProcessesClosed = false;

    try {
      const ready = await waitForFixtureReady(core, nonce, () => coreStderr);
      expect(ready.corePid).toBe(core.pid);
      await heartbeat.waitForHeartbeat(heartbeatNonce);

      observer = spawn(observerExe, [
        String(ready.corePid),
        String(ready.helperPid),
        String(ready.workerPid),
        String(ready.descendantPid),
      ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: environment.SYSTEMROOT!,
          WINDIR: environment.WINDIR!,
        },
      });
      const observerReady = waitForText(observer, "READY", 5_000);
      observerClose = observeClose(observer);
      void observerClose.catch(() => undefined);
      await observerReady;
      const observerConfirmedClose = waitForText(observer, "CLOSED", 30_000);
      void observerConfirmedClose.catch(() => undefined);

      const verification = waitForFixtureVerified(core, nonce);
      core.send({ type: "verify", nonce });
      const verified = await verification;
      expect(verified.corePid).toBe(ready.corePid);
      expect(verified.helperPid).toBe(ready.helperPid);
      expect(verified.workerPid).toBe(ready.workerPid);
      expect(verified.descendantPid).toBe(ready.descendantPid);
      expect(core.exitCode).toBeNull();
      expect(core.signalCode).toBeNull();
      expect(heartbeat.isConnected(heartbeatNonce)).toBe(true);

      if (!core.kill()) throw new Error("Could not terminate the exact Core fixture process handle.");
      await bounded(coreClose, 30_000, "Core fixture process did not close after exact-handle termination.");
      await heartbeat.waitForDisconnect(heartbeatNonce);
      await observerConfirmedClose;
      await bounded(observerClose, 35_000, "Process observer did not exit after confirming owned process handles.");
      allExactProcessesClosed = true;
    } finally {
      let cleanupError: unknown;
      if (core.exitCode === null && core.signalCode === null) {
        // This is the exact ChildProcess handle created above, never a PID scan.
        core.kill();
      }
      try { await bounded(coreClose, 30_000, "Core fixture process did not close during exact-handle cleanup."); } catch (error) { cleanupError = error; }
      await heartbeat.close();
      if (observer && observer.exitCode === null && observer.signalCode === null) {
        // The observer is this test's own process, not any worker/helper.
        observer.kill();
      }
      if (observerClose) {
        try { await bounded(observerClose, 35_000, "Process observer did not close during cleanup."); } catch (error) { cleanupError ??= error; }
      }
      if (allExactProcessesClosed && !cleanupError) {
        const currentRootPath = await realpath(root);
        const currentRootIdentity = await lstat(root, { bigint: true });
        if (currentRootPath !== ownedRootPath || !sameDirectoryIdentity(currentRootIdentity, ownedRootIdentity)
          || path.dirname(ownedRootPath) !== ownedParent) {
          throw new Error("Refusing to remove a changed test-owned root.");
        }
        const junctionStat = await lstat(tempJunction, { bigint: true });
        if (!junctionStat.isSymbolicLink() || (await realpath(tempJunction)) !== canonicalRoot) {
          throw new Error("Refusing to remove a changed test TEMP junction.");
        }
        const currentCanonicalIdentity = await lstat(canonicalTempRoot, { bigint: true });
        if (!sameDirectoryIdentity(currentCanonicalIdentity, canonicalTempIdentity)) {
          throw new Error("Refusing to remove a changed canonical TEMP target.");
        }
        await rmdir(tempJunction);
        if ((await realpath(root)) !== ownedRootPath
          || !sameDirectoryIdentity(await lstat(root, { bigint: true }), ownedRootIdentity)
          || path.dirname(canonicalRoot) !== ownedRootPath) {
          throw new Error("Refusing to remove a temp directory outside this test root.");
        }
        await rm(root, { recursive: true, force: false });
      }
      if (cleanupError) throw cleanupError;
    }
  }, 60_000);
});
