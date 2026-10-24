import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { escapeCmdArgument, escapeCmdCommand } from "./windows-cmd-escape.js";

/** Preserve literal argv through npm's Windows command shims. */
export function spawnAdapterProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return spawn(command, args, options);
  const shell = path.join(options.env?.SystemRoot || process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  // Every batch shim reparses %*. Global npm shims need the same second
  // escaping pass as node_modules/.bin shims, not a path-name heuristic.
  const commandLine = [escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(" ");
  return spawn(shell, ["/d", "/s", "/v:off", "/c", `"${commandLine}"`], {
    ...options, env: { ...options.env, ComSpec: shell }, windowsVerbatimArguments: true,
  });
}
