import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { terminateLocalService } from "../services/local-service-supervisor.js";

const execFileAsync = promisify(execFile);

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readFirstLine(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline).trim());
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

describe.skipIf(process.platform !== "win32")("Windows local service termination", () => {
  it("terminates descendants before the parent can orphan them", async () => {
    const childCode = "setInterval(() => {}, 1000)";
    const parentCode = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore", windowsHide: true });`,
      'process.stdout.write(String(child.pid) + "\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", parentCode], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const parentPid = parent.pid!;
    const childPid = Number.parseInt(await readFirstLine(parent.stdout!), 10);

    try {
      expect(isAlive(parentPid)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
      await terminateLocalService({ pid: parentPid, processGroupId: null }, { forceAfterMs: 1_000 });
      await delay(250);
      expect(isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      if (isAlive(parentPid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(parentPid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
      }
      if (isAlive(childPid)) {
        await execFileAsync("taskkill.exe", ["/PID", String(childPid), "/F"], { windowsHide: true }).catch(() => undefined);
      }
    }
  });
});
