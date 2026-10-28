import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createPluginWorkerProcessAdapter } from "../services/plugin-worker-process.js";

const compilerPath = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const sourcePath = "C:\\core\\WindowsJobSupervisor.cs";
const rawTempPath = "C:\\TempAlias";
const canonicalTempPath = "D:\\PrivateTemp";
const helperDirectory = `${canonicalTempPath}\\sps-core-plugin-worker-test`;
const helperOutput = `${helperDirectory}\\SpsCorePluginWorkerSupervisor.exe`;

function directoryStat(identity: number) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    dev: 7n,
    ino: BigInt(identity),
    birthtimeNs: BigInt(identity + 100),
  };
}

function createPreparationHarness(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const access = vi.fn(async (target: string) => {
    calls.push(`access:${target}`);
  });
  const realpath = vi.fn(async (target: string) => {
    calls.push(`realpath:${target}`);
    if (target === rawTempPath) return canonicalTempPath;
    return target;
  });
  const lstat = vi.fn(async (target: string) => {
    calls.push(`lstat:${target}`);
    return directoryStat(target === canonicalTempPath ? 1 : 2);
  });
  const mkdtemp = vi.fn(async (prefix: string) => {
    calls.push(`mkdtemp:${prefix}`);
    return helperDirectory;
  });
  const rm = vi.fn(async () => undefined);
  const compile = vi.fn(async (_compiler: string, _args: string[], _options: unknown) => {
    calls.push("compile");
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999,
    supervisorReady: Promise.resolve(1234),
    terminateOwnedJob: vi.fn(async () => undefined),
    waitForOwnedJobTermination: vi.fn(async () => undefined),
    hasUnconfirmedOwnedJobTermination: () => false,
  });
  const spawnWindows = vi.fn(() => child);
  const adapter = createPluginWorkerProcessAdapter({
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    cwd: () => "C:\\plugins",
    spawnWindows: spawnWindows as never,
    helperPreparationDependencies: {
      platform: "win32",
      windir: "C:\\Windows",
      temporaryDirectory: () => rawTempPath,
      sourcePath,
      pathApi: path.win32,
      access: access as never,
      realpath: realpath as never,
      lstat: lstat as never,
      mkdtemp: mkdtemp as never,
      rm: rm as never,
      compile: compile as never,
      ...overrides,
    },
  });
  return { adapter, calls, access, realpath, lstat, mkdtemp, compile, rm, spawnWindows };
}

describe("Windows plugin helper preparation diagnostics", () => {
  it("reports a missing compiler with bounded phase and code only", async () => {
    const { adapter, access } = createPreparationHarness();
    access.mockRejectedValueOnce(Object.assign(new Error("C:\\private\\compiler path"), { code: "ENOENT" }));

    await expect(adapter.preparePluginWorkerProcess()).rejects.toThrow(
      "Windows plugin worker process ownership could not be prepared. [phase=compiler_access, code=ENOENT]",
    );
  });

  it("reports a missing source without exposing its path or raw error", async () => {
    const { adapter, access } = createPreparationHarness();
    access.mockImplementationOnce(async () => undefined);
    access.mockRejectedValueOnce(Object.assign(new Error(`${sourcePath} missing`), { code: "ENOENT" }));

    await expect(adapter.preparePluginWorkerProcess()).rejects.toThrow(
      "Windows plugin worker process ownership could not be prepared. [phase=source_access, code=ENOENT]",
    );
  });

  it("creates the helper below the canonical target of a junctioned temp path", async () => {
    const { adapter, calls, mkdtemp, compile, spawnWindows } = createPreparationHarness();

    await expect(adapter.preparePluginWorkerProcess()).resolves.toBeUndefined();
    expect(mkdtemp).toHaveBeenCalledWith(`${canonicalTempPath}\\sps-core-plugin-worker-`);
    expect(calls).toContain(`realpath:${rawTempPath}`);
    expect(calls.indexOf(`realpath:${rawTempPath}`)).toBeLessThan(calls.indexOf(`mkdtemp:${canonicalTempPath}\\sps-core-plugin-worker-`));
    expect(compile).toHaveBeenCalledWith(
      compilerPath,
      expect.arrayContaining([`/out:${helperOutput}`, sourcePath]),
      expect.objectContaining({ windowsHide: true, shell: false }),
    );
    adapter.spawnPluginWorkerProcess("C:\\plugins\\entry.js", { env: {}, execArgv: [] });
    expect(spawnWindows.mock.calls[0]?.[1].helperPath).toBe(helperOutput);
  });

  it("reports compiler failure without leaking output, command, or directory", async () => {
    const { adapter, compile } = createPreparationHarness();
    compile.mockRejectedValueOnce(Object.assign(new Error(`${helperOutput} PRIVATE COMPILER OUTPUT`), {
      code: 1,
      stdout: "private stdout",
      stderr: "private stderr",
    }));

    let caught: unknown;
    try {
      await adapter.preparePluginWorkerProcess();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe("Windows plugin worker process ownership could not be prepared. [phase=compile, code=COMPILE_FAILED]");
    expect(message).not.toContain(helperOutput);
    expect(message).not.toContain("PRIVATE COMPILER OUTPUT");
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("reduces unrecognized error codes to UNKNOWN", async () => {
    const { adapter, compile } = createPreparationHarness();
    compile.mockRejectedValueOnce(Object.assign(new Error("raw detail must not escape"), {
      code: "C:\\private\\unexpected-code",
    }));

    await expect(adapter.preparePluginWorkerProcess()).rejects.toThrow(
      "Windows plugin worker process ownership could not be prepared. [phase=compile, code=UNKNOWN]",
    );
  });

  it("rejects a replaced helper directory after compile and does not remove it", async () => {
    let helperDirectoryChecks = 0;
    const lstat = vi.fn(async (target: string) => {
      if (target === canonicalTempPath) return directoryStat(1);
      helperDirectoryChecks += 1;
      return directoryStat(helperDirectoryChecks >= 3 ? 9 : 2);
    });
    const { adapter, rm } = createPreparationHarness({ lstat: lstat as never });

    await expect(adapter.preparePluginWorkerProcess()).rejects.toThrow(
      "Windows plugin worker process ownership could not be prepared. [phase=output_validate, code=UNKNOWN]",
    );
    expect(rm).not.toHaveBeenCalled();
  });
});
