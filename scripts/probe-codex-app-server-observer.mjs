import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexAppServerReadClient } from "../packages/adapters/codex-local/src/server/app-server-read-client.ts";
import { readCodexDirectChildren } from "../packages/adapters/codex-local/src/server/app-server-descendants.ts";

// Developer-only no-model probe. No production adapter selection or account fallback.
const command = process.argv[2];
if (process.argv.length !== 3 || !command || !path.isAbsolute(command)
  || /\.(cmd|bat|ps1|js|mjs)$/i.test(command) || !(await stat(command)).isFile()) {
  throw new Error("Pass exactly one absolute native Codex executable path.");
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
try {
  const versionResult = await promisify(execFile)(command, ["--version"], {
    cwd, env, windowsHide: true, timeout: 10_000, maxBuffer: 4096,
  });
  const version = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\s*$/.exec(versionResult.stdout)?.[1];
  if (!version) throw new Error("Unexpected Codex version output.");
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
  client = createCodexAppServerReadClient({ input: child.stdout, output: child.stdin });
  await client.initialize();
  const observed = await readCodexDirectChildren(client.request, "00000000-0000-4000-8000-000000000001", { maxPages: 1 });
  if (observed.children.length !== 0) throw new Error("An isolated observer profile unexpectedly contained children.");
  client.close();
  child.stdin.end();
  const exit = await Promise.race([exitPromise, new Promise(resolve => setTimeout(() => resolve(null), 10_000).unref())]);
  if (!exit || exit.code !== 0 || exit.signal) throw new Error("Observer app-server did not exit normally.");
  console.log(JSON.stringify({ schemaVersion: 1, kind: "isolated-no-model-protocol-probe", version,
    initialize: "passed", directChildFilter: "passed", childCount: 0,
    modelTurnsStarted: 0, realNativeChildExecution: "not-tested", adapterActivated: false,
    exitCode: exit.code }));
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
