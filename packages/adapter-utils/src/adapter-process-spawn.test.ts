import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("Windows command shim argv", () => {
  it.each(["global-bin", "node_modules/.bin"])("round-trips literal arguments through %s", async relativeBin => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sps argv 한글 "));
    const previousShell = process.env.ComSpec;
    try {
      const bin = path.join(root, ...relativeBin.split("/"));
      await fs.mkdir(bin, { recursive: true });
      const script = path.join(bin, "argv.cjs");
      const shim = path.join(bin, "sps-argv.cmd");
      await fs.writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      await fs.writeFile(shim, '@echo off\r\n"%SPS_ARGV_NODE%" "%~dp0argv.cjs" %*\r\n');
      const args = [
        "exec", "--json", "-c", `mcp_servers.test.args=${JSON.stringify(["C:\\한글 경로\\bridge.mjs"])}`,
        "-c", 'model_reasoning_effort="xhigh"', "", "a b", 'embedded"quote', "C:\\trailing\\",
        "a&b|c<d>e^f(g)", "%SPS_ARGV_SENTINEL%", "!SPS_ARGV_SENTINEL!", "-",
      ];
      const result = await runChildProcess(randomUUID(), shim, args, {
        cwd: root, env: { SPS_ARGV_NODE: process.execPath, SPS_ARGV_SENTINEL: "must-not-expand", ComSpec: "powershell.exe" },
        timeoutSec: 10, graceSec: 1, onLog: async () => {},
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(process.env.ComSpec).toBe(previousShell);
    } finally {
      // This target is the fixed mkdtemp return, never an input-derived path.
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^sps argv /);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
