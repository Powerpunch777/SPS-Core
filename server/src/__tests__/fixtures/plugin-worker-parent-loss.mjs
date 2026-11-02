import childProcess from "node:child_process";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const nonce = process.env.SPS_TEST_PARENT_LOSS_NONCE;
const helpers = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn(command, args, options);
  if (path.basename(String(command)).toLowerCase() === "spscorepluginworkersupervisor.exe") {
    helpers.push(child);
  }
  return child;
};
syncBuiltinESMExports();

const { createPluginWorkerManager } = await import("../../services/plugin-worker-manager.js");
const manager = createPluginWorkerManager();
const workspaceId = "33333333-3333-4333-8333-333333333333";
const pluginId = "worker.parent-loss.test";
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugin-worker-descendant.mjs");
const manifest = {
  id: pluginId,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Parent loss fixture",
  description: "Test fixture",
  author: "SPS",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const handle = await manager.startWorkspaceWorker(workspaceId, pluginId, {
  entrypointPath: fixturePath,
  manifest,
  config: {},
  instanceInfo: { instanceId: "parent-loss-test", hostVersion: "1.0.0" },
  apiVersion: 1,
  hostHandlers: {},
  autoRestart: false,
  rpcTimeoutMs: 2_000,
  env: {
    SPS_TEST_HEARTBEAT_PORT: process.env.SPS_TEST_HEARTBEAT_PORT,
    SPS_TEST_HEARTBEAT_NONCE: process.env.SPS_TEST_HEARTBEAT_NONCE,
    SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? "C:\\Windows",
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  },
});

const health = await handle.call("health", {}, 2_000);
const helper = helpers[0];
if (!helper?.pid || typeof health?.descendantPid !== "number") {
  throw new Error("Parent-loss fixture could not observe its process ownership handles.");
}

process.send({
  type: "ready",
  nonce,
  corePid: process.pid,
  helperPid: helper.pid,
  workerPid: health.workerPid,
  descendantPid: health.descendantPid,
});

process.on("message", message => {
  if (!message || message.type !== "verify" || message.nonce !== nonce) return;
  void handle.call("health", {}, 2_000).then(currentHealth => {
    process.send({
      type: "verified",
      nonce,
      corePid: process.pid,
      helperPid: helper.pid,
      helperAlive: helper.exitCode === null && helper.signalCode === null,
      workerPid: currentHealth.workerPid,
      descendantPid: currentHealth.descendantPid,
    });
  }, () => process.send({ type: "verification-failed", nonce }));
});

// This fixture intentionally never calls manager.shutdown(). The parent
// terminates this exact Core process to exercise the helper's parent-loss path.
process.on("disconnect", () => {});
