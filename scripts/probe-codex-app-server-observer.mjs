import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexAppServerReadClient, createCodexAppServerStateProbeClient } from "../packages/adapters/codex-local/src/server/app-server-read-client.ts";
import { readCodexDirectChildren } from "../packages/adapters/codex-local/src/server/app-server-descendants.ts";
import { parseCodexThreadGoalResult } from "../packages/adapters/codex-local/src/server/app-server-goal-state.ts";

// Developer-only no-model probe. No production adapter selection or account fallback.
const command = process.argv[2];
const mode = process.argv[3];
if (process.argv.length < 3 || process.argv.length > 4 || mode !== undefined && mode !== "--paused-goal"
  || !command || !path.isAbsolute(command)
  || /\.(cmd|bat|ps1|js|mjs)$/i.test(command) || !(await stat(command)).isFile()) {
  throw new Error("Pass one absolute native Codex executable path and optional --paused-goal.");
}
const temp = await realpath(os.tmpdir());
const root = await mkdtemp(path.join(temp, "sps-codex-observer-"));
const home = path.join(root, "home"), cwd = path.join(root, "workspace");
await mkdir(home);
await mkdir(cwd);
const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home,
  LOCALAPPDATA: home, TEMP: root, TMP: root, NO_COLOR: "1" };
for (const name of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
  if (process.env[name]) env[name] = process.env[name];
}
let child, client, exitPromise, exited = true;
async function withServer(createClient, operation) {
  if (!exited) throw new Error("Previous observer process has not exited.");
  // app-server 0.144.1 has no exec-only --ignore-user-config flag. The
  // newly-created CODEX_HOME and workspace provide its empty local profile.
  child = spawn(command, ["app-server", "--listen", "stdio://"], {
    cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  exited = false;
  exitPromise = new Promise((resolve, reject) => {
    child.once("error", error => { exited = true; client?.close(); reject(error); });
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  void exitPromise.catch(() => undefined);
  child.stdin.on("error", () => {});
  // Drain, but never publish paths, identity, or arbitrary stderr content.
  child.stderr.resume();
  client = createClient({ input: child.stdout, output: child.stdin });
  await client.initialize();
  const result = await operation(client);
  client.close();
  child.stdin.end();
  const exit = await Promise.race([exitPromise, new Promise(resolve => setTimeout(() => resolve(null), 10_000).unref())]);
  if (!exit || exit.code !== 0 || exit.signal) throw new Error("Observer app-server did not exit normally.");
  return result;
}
try {
  const versionResult = await promisify(execFile)(command, ["--version"], {
    cwd, env, windowsHide: true, timeout: 10_000, maxBuffer: 4096,
  });
  const version = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\s*$/.exec(versionResult.stdout)?.[1];
  if (!version) throw new Error("Unexpected Codex version output.");
  if (mode === "--paused-goal") {
    const objective = "SPS isolated paused-goal persistence probe; do not run model work.";
    const permissions = { sandbox: "read-only", approvalPolicy: "never", config: {
      "features.shell_tool": false, "features.multi_agent": false, "features.hooks": false,
      "features.apps": false, "features.plugins": false,
    } };
    const first = await withServer(createCodexAppServerStateProbeClient, async rpc => {
      const started = await rpc.request("thread/start", { cwd, ephemeral: false, ...permissions });
      const id = started?.thread?.id;
      if (typeof id !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) {
        throw new Error("State probe thread creation returned no valid identity.");
      }
      const initial = parseCodexThreadGoalResult(await rpc.request("thread/goal/get", { threadId: id }), id);
      if (initial !== null) throw new Error("New isolated thread already has a goal.");
      const saved = parseCodexThreadGoalResult(await rpc.request("thread/goal/set", {
        threadId: id, objective, status: "paused",
      }), id);
      if (!saved || saved.status !== "paused" || saved.objective !== objective
        || saved.tokensUsed !== 0 || saved.timeUsedSeconds !== 0) throw new Error("Paused goal write did not match.");
      return { id, saved };
    });
    const second = await withServer(createCodexAppServerStateProbeClient, async rpc => {
      const restored = parseCodexThreadGoalResult(await rpc.request("thread/goal/get", { threadId: first.id }), first.id);
      if (JSON.stringify(restored) !== JSON.stringify(first.saved)) throw new Error("Goal state changed across process restart.");
      const resumed = await rpc.request("thread/resume", { threadId: first.id, cwd, ...permissions });
      if (resumed?.thread?.id !== first.id) throw new Error("Resume returned a different thread identity.");
      const paused = parseCodexThreadGoalResult(await rpc.request("thread/goal/get", { threadId: first.id }), first.id);
      if (JSON.stringify(paused) !== JSON.stringify(restored)) throw new Error("Resume changed the paused goal state.");
      await rpc.request("thread/goal/clear", { threadId: first.id });
      const cleared = parseCodexThreadGoalResult(await rpc.request("thread/goal/get", { threadId: first.id }), first.id);
      if (cleared !== null) throw new Error("Goal clear did not persist.");
      return { restored: true, resumed: true, cleared: true };
    });
    console.log(JSON.stringify({ schemaVersion: 1, kind: "isolated-paused-goal-state-probe", version,
      persistedAcrossProcessRestart: second.restored, sameThreadResumed: second.resumed, clear: second.cleared,
      observedTokensUsed: 0, observedTimeUsedSeconds: 0, clientTurnStartRequests: 0,
      automaticContinuation: "not-tested", realNativeChildExecution: "not-tested", adapterActivated: false,
      processesNormallyExited: 2 }));
  } else {
    await withServer(createCodexAppServerReadClient, async rpc => {
      const observed = await readCodexDirectChildren(rpc.request, "00000000-0000-4000-8000-000000000001", { maxPages: 1 });
      if (observed.children.length !== 0) throw new Error("An isolated observer profile unexpectedly contained children.");
    });
    console.log(JSON.stringify({ schemaVersion: 1, kind: "isolated-no-model-protocol-probe", version,
      initialize: "passed", directChildFilter: "passed", childCount: 0,
      modelTurnsStarted: 0, realNativeChildExecution: "not-tested", adapterActivated: false, exitCode: 0 }));
  }
} finally {
  client?.close();
  if (child && !exited) {
    child.stdin.end();
    await Promise.race([exitPromise.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (!exited) {
      child.kill();
      await Promise.race([exitPromise.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  }
  if (!exited) throw new Error("Observer process exit is unconfirmed; isolated profile retained.");
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("sps-codex-observer-")) {
    throw new Error("Refusing cleanup outside the owned temporary profile.");
  }
  await rm(resolved, { recursive: true, force: false });
}
