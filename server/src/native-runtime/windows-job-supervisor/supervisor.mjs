import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { access } from "node:fs/promises";
import path from "node:path";

const PIPE_PREFIX = "sps-node-job-";
const MAX_FRAME_BYTES = 262_144;

function validateInvocation(invocation, pathApi) {
  const environmentNames = new Set();
  const duplicateEnvironmentNames = Object.entries(invocation?.env ?? {}).some(([key]) => {
    const canonical = key.toLocaleLowerCase("en-US");
    if (environmentNames.has(canonical)) return true;
    environmentNames.add(canonical);
    return false;
  });
  if (!invocation || typeof invocation !== "object" || typeof invocation.executable !== "string"
      || !pathApi.isAbsolute(invocation.executable) || typeof invocation.cwd !== "string" || !pathApi.isAbsolute(invocation.cwd)
      || !Array.isArray(invocation.args) || invocation.args.some(value => typeof value !== "string" || value.includes("\0"))
      || !invocation.env || typeof invocation.env !== "object" || Array.isArray(invocation.env)
      || duplicateEnvironmentNames
      || Object.entries(invocation.env).some(([key, value]) => !key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0"))) {
    throw new TypeError("Invalid Windows supervised command invocation.");
  }
}

function sameWindowsExitCode(actual, expected) {
  return Number.isInteger(actual) && actual >= -2_147_483_648 && actual <= 0xffff_ffff
    && Number.isInteger(expected) && expected >= 0 && expected <= 0xffff_ffff
    && (actual >>> 0) === (expected >>> 0);
}

function parseFrames(socket, onMessage, onFailure, onClose = () => onFailure()) {
  let pending = Buffer.alloc(0);
  socket.on("data", chunk => {
    if (!Buffer.isBuffer(chunk) || chunk.length > MAX_FRAME_BYTES || pending.length + chunk.length > MAX_FRAME_BYTES) {
      return onFailure();
    }
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(10);
      if (newline < 0) break;
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      try { onMessage(JSON.parse(frame.toString("utf8"))); }
      catch { onFailure(); }
    }
  });
  socket.on("error", () => onFailure());
  socket.on("close", onClose);
}

async function connectToPipe(address, connect, shouldStop, signal) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (shouldStop() || signal.aborted) throw new Error("Windows command supervisor startup failed.");
    let socket;
    try { socket = connect(address); }
    catch (error) { lastError = error; await delay(50); continue; }
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const onConnect = () => { cleanup(); resolve(); };
        const onError = error => { cleanup(); reject(error); };
        const onAbort = () => { cleanup(); reject(new Error("Windows command supervisor startup failed.")); };
        if (signal.aborted) return onAbort();
        socket.once("connect", onConnect);
        socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return socket;
    } catch (error) {
      lastError = error;
      socket.destroy();
      if (signal.aborted || shouldStop()) throw new Error("Windows command supervisor startup failed.");
      await delay(50);
    }
  }
  throw lastError ?? new Error("Windows command supervisor connection failed.");
}

export function spawnWindowsJobSupervisor(invocation, internal = {}) {
  const platform = internal.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Windows Job Object command supervision is unavailable on this platform.");
  const pathApi = path.win32;
  validateInvocation(invocation, pathApi);
  const helper = internal.helperPath;
  const pipeName = `${PIPE_PREFIX}${process.pid}-${randomBytes(24).toString("hex")}`;
  const nonce = randomBytes(32).toString("hex");
  if (!pathApi.isAbsolute(helper)) throw new Error("Windows command supervision helper is unavailable.");
  const helperChild = (internal.spawn ?? nodeSpawn)(helper, ["--supervise", pipeName, String(process.pid), nonce], {
    cwd: pathApi.dirname(helper), env: { SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows", WINDIR: process.env.WINDIR ?? "C:\\Windows", PATH: process.env.PATH ?? "" },
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const connect = internal.connect ?? net.createConnection;
  const connectAbortController = new AbortController();
  let socket;

  let readyResolve;
  let readyReject;
  let ackResolve;
  let ackReject;
  let terminalResolve;
  let terminalReject;
  let ready = false;
  let supervisedProcessId = null;
  let helloAccepted = false;
  let ended = false;
  let cancelSent = false;
  let terminalMessage;
  let helperCloseInfo;
  let failureLatched = false;
  let unconfirmedTermination = false;
  let helperCloseResolve;
  let helperCloseReject;
  let cancellationTimer;
  let helperCloseTimer;
  let helperKillTimer;
  const supervisorReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const terminationAck = new Promise((resolve, reject) => { ackResolve = resolve; ackReject = reject; });
  const supervisorTerminal = new Promise((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
  const helperClosed = new Promise((resolve, reject) => { helperCloseResolve = resolve; helperCloseReject = reject; });
  // Attach observers immediately while preserving these original promises for API callers.
  void terminationAck.catch(() => {});
  void supervisorTerminal.catch(() => {});
  void helperClosed.catch(() => {});
  void supervisorReady.catch(() => {});
  const startupTimer = setTimeout(() => fail(new Error("Windows command supervisor startup timed out.")), internal.startupTimeoutMs ?? 15_000);
  startupTimer.unref?.();

  function safeFailure() {
    return ready
      ? new Error("Windows command supervision failed.")
      : new Error("Windows command supervisor startup failed.");
  }

  function killExactHelper() {
    if (ended || helperChild.killed) return;
    try { helperChild.kill(); } catch { /* Keep the termination result unconfirmed. */ }
  }

  function scheduleHelperKill(milliseconds = internal.failureKillGraceMs ?? 1_000) {
    if (ended || helperKillTimer !== undefined) return;
    helperKillTimer = setTimeout(() => {
      helperKillTimer = undefined;
      killExactHelper();
    }, milliseconds);
    helperKillTimer.unref?.();
  }

  function fail() {
    if (failureLatched) return;
    failureLatched = true;
    unconfirmedTermination = true;
    const safeError = safeFailure();
    if (!ready) readyReject(safeError);
    if (!terminalMessage) terminalReject(new Error("Windows command supervisor termination is unconfirmed."));
    if (cancelSent) ackReject(new Error("Windows command supervisor termination is unconfirmed."));
    helperCloseReject(new Error("Windows command supervisor termination is unconfirmed."));
    connectAbortController.abort();
    if (socket && !socket.destroyed) socket.destroy();
    if (!ended) scheduleHelperKill();
  }

  helperChild.once("error", () => fail());
  helperChild.once("close", (code, signal) => {
    ended = true;
    clearTimeout(startupTimer);
    clearTimeout(cancellationTimer);
    clearTimeout(helperCloseTimer);
    clearTimeout(helperKillTimer);
    helperCloseInfo = { code, signal };
    if (!ready) return fail();
    if (terminalMessage) return confirmHelperClose();
    if (!socket || socket.destroyed) return fail();
    // stdout/stderr close and named-pipe data can be observed in either order.
    // Keep a short drain window for a terminal frame flushed before helper exit.
    helperCloseTimer = setTimeout(() => fail(), internal.terminalDrainTimeoutMs ?? 250);
    helperCloseTimer.unref?.();
  });

  function exactKeys(message, keys) {
    const actual = Object.keys(message).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function confirmHelperClose() {
    clearTimeout(helperCloseTimer);
    if (!helperCloseInfo) return;
    const expectedCode = terminalMessage.type === "cancelled" ? 125 : terminalMessage.code;
    if (helperCloseInfo.signal !== null || !sameWindowsExitCode(helperCloseInfo.code, expectedCode) || failureLatched) {
      unconfirmedTermination = true;
      failureLatched = true;
      helperCloseReject(new Error("Windows command supervisor termination is unconfirmed."));
      if (socket && !socket.destroyed) socket.destroy();
      return;
    }
    helperCloseResolve(helperCloseInfo);
  }

  function acceptTerminal(message) {
    terminalMessage = message;
    if (cancelSent) {
      clearTimeout(cancellationTimer);
      // Natural exit is a valid terminal result for a concurrent cancel wait;
      // return the actual exit frame so callers can distinguish it from cancel.
      ackResolve(message);
    }
    terminalResolve(message);
    if (helperCloseInfo) return confirmHelperClose();
    helperCloseTimer = setTimeout(() => {
      if (ended) return;
      failureLatched = true;
      unconfirmedTermination = true;
      helperCloseReject(new Error("Windows command supervisor termination is unconfirmed."));
      if (socket && !socket.destroyed) socket.destroy();
      killExactHelper();
    }, internal.helperCloseTimeoutMs ?? 5_000);
    helperCloseTimer.unref?.();
  }

  void connectToPipe("\\\\.\\pipe\\" + pipeName, connect, () => failureLatched || ended, connectAbortController.signal).then(connectedSocket => {
    socket = connectedSocket;
    parseFrames(socket, message => {
      if (failureLatched) return;
      if (!message || typeof message !== "object" || Array.isArray(message)) return fail();
      if (terminalMessage) return fail();
      if (!helloAccepted) {
        if (!exactKeys(message, ["type", "nonce"]) || message.type !== "hello" || message.nonce !== `${process.pid}:${pipeName}:${nonce}`) {
          return fail();
        }
        helloAccepted = true;
        const manifest = JSON.stringify({
          type: "start",
          nonce: `${process.pid}:${pipeName}:${nonce}`,
          manifest: { executable: invocation.executable, args: invocation.args, cwd: invocation.cwd, env: invocation.env },
        });
        if (Buffer.byteLength(manifest, "utf8") > MAX_FRAME_BYTES - 1) return fail();
        socket.write(`${manifest}\n`);
        return;
      }
      if (message.type === "ready") {
        if (!exactKeys(message, ["type", "pid"]) || ready
            || !Number.isSafeInteger(message.pid) || message.pid < 1) return fail();
        supervisedProcessId = message.pid;
        ready = true;
        clearTimeout(startupTimer);
        readyResolve(supervisedProcessId);
        return;
      }
      if (message.type === "cancelled") {
        if (!ready || !exactKeys(message, ["type", "activeProcesses"]) || message.activeProcesses !== 0 || !cancelSent) return fail();
        acceptTerminal(message);
        return;
      }
      if (message.type === "exit") {
        if (!ready || !exactKeys(message, ["type", "activeProcesses", "code"]) || message.activeProcesses !== 0
            || !Number.isInteger(message.code) || message.code < 0 || message.code > 0xffff_ffff) return fail();
        acceptTerminal(message);
        return;
      }
      if (message.type === "error") {
        const stages = new Set(["startup", "pipe-create", "pipe-connect", "pipe-connect-begin", "pipe-connect-wait", "pipe-connect-end",
          "authenticate-client", "read-manifest", "manifest-executable", "manifest-cwd", "manifest-args", "manifest-env", "resolve-command",
          "build-environment", "prepare-standard-handles", "create-suspended", "assign-job", "resume-child", "create-job", "report-ready",
          "wait-child", "confirm-job-empty", "control-failure"]);
        const categories = new Set(["timeout", "access", "security", "io", "argument", "win32", "invalid-data", "other"]);
        if (!exactKeys(message, ["type", "code", "stage", "category"]) || message.code !== "supervisor-failed"
            || !stages.has(message.stage) || !categories.has(message.category)) return fail();
        return fail();
      }
      fail();
    }, fail, () => {
      if (!terminalMessage) fail();
    });

    socket.on("error", () => { if (!terminalMessage) fail(); });
  }).catch(() => {
    fail();
  });

  async function terminateOwnedJob() {
    await supervisorReady;
    if (terminalMessage?.activeProcesses === 0) return waitForOwnedJobTermination();
    if (!cancelSent) {
      if (!socket || socket.destroyed) {
        fail();
        throw new Error("Windows command supervisor termination is unconfirmed.");
      }
      cancelSent = true;
      cancellationTimer = setTimeout(() => fail(new Error("Windows command supervisor cancellation acknowledgment timed out.")), internal.cancellationTimeoutMs ?? 25_000);
      cancellationTimer.unref?.();
      try { socket.write('{"type":"cancel"}\n'); }
      catch {
        fail();
        throw new Error("Windows command supervisor termination is unconfirmed.");
      }
    }
    await terminationAck;
    return waitForOwnedJobTermination();
  }

  async function waitForOwnedJobTermination() {
    const message = terminalMessage ?? await supervisorTerminal;
    await helperClosed;
    if (unconfirmedTermination) throw new Error("Windows command supervisor termination is unconfirmed.");
    return message;
  }

  helperChild.terminateOwnedJob = terminateOwnedJob;
  helperChild.waitForOwnedJobTermination = waitForOwnedJobTermination;
  helperChild.hasUnconfirmedOwnedJobTermination = () => unconfirmedTermination;
  helperChild.supervisorReady = supervisorReady;
  helperChild.supervisorTerminal = supervisorTerminal;
  return helperChild;
}

export async function assertWindowsJobSupervisorAvailable(internal = {}) {
  const platform = internal.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Windows Job Object command supervision is unavailable on this platform.");
  const executable = internal.helperPath ?? bundledHelperPath();
  try { await (internal.access ?? access)(executable); }
  catch { throw new Error("Windows command supervision helper is unavailable; command execution is disabled."); }
  return executable;
}
