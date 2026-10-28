import { execFile as nodeExecFile, fork as nodeFork, type ChildProcess } from "node:child_process";
import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  spawnWindowsJobSupervisor,
  type WindowsJobSupervisorInvocation,
  type WindowsSupervisedProcess,
} from "../native-runtime/windows-job-supervisor/supervisor.mjs";

const execFile = promisify(nodeExecFile);
const HELPER_PREFIX = "sps-core-plugin-worker-";
const COMPILE_TIMEOUT_MS = 30_000;
const COMPILE_MAX_BUFFER = 16 * 1024;

export type PluginWorkerProcessOptions = Readonly<{
  env: Readonly<Record<string, string>>;
  execArgv: readonly string[];
  cwd?: string;
}>;

export type PluginWorkerProcessOwnership = Readonly<{
  ready: Promise<void>;
  terminate(): Promise<unknown>;
  waitForClosure(): Promise<unknown>;
  hasUnconfirmed(): boolean;
  processId(): number | null;
}>;

type SupervisedChild = WindowsSupervisedProcess & ChildProcess;

type AdapterDependencies = Readonly<{
  platform?: NodeJS.Platform;
  execPath?: string;
  cwd?: () => string;
  fork?: typeof nodeFork;
  prepareWindowsHelper?: () => void | Promise<void>;
  windowsHelperPath?: () => string | null;
  spawnWindows?: (
    invocation: WindowsJobSupervisorInvocation,
    internal: { helperPath: string; platform: NodeJS.Platform },
  ) => SupervisedChild;
}>;

let helperExecutable: string | null = null;
let helperPreparation: Promise<void> | null = null;

function isAbsoluteWindowsPath(value: string): boolean {
  return path.win32.isAbsolute(value);
}

function assertWorkerOptions(entrypoint: string, options: PluginWorkerProcessOptions, platform: NodeJS.Platform): void {
  const environmentNames = new Set<string>();
  const duplicateEnvironmentNames = Object.keys(options?.env ?? {}).some(key => {
    const canonical = key.toUpperCase();
    if (environmentNames.has(canonical)) return true;
    environmentNames.add(canonical);
    return false;
  });
  if (typeof entrypoint !== "string" || !entrypoint || entrypoint.includes("\0")
    || !options || typeof options !== "object" || Array.isArray(options)
    || !options.env || typeof options.env !== "object" || Array.isArray(options.env)
    || platform === "win32" && duplicateEnvironmentNames
    || Object.entries(options.env).some(([key, value]) => !key || key.includes("=") || key.includes("\0")
      || typeof value !== "string" || value.includes("\0"))
    || !Array.isArray(options.execArgv) || options.execArgv.some(value => typeof value !== "string" || value.includes("\0"))
    || (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.includes("\0")))) {
    throw new TypeError("Invalid plugin worker process invocation.");
  }
}

function windowsWorkerEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  const result = { ...environment };
  const names = new Set(Object.keys(result).map(key => key.toUpperCase()));
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  if (!names.has("SYSTEMROOT")) result.SYSTEMROOT = systemRoot;
  if (!names.has("WINDIR")) result.WINDIR = process.env.WINDIR ?? systemRoot;
  return result;
}

function ownedTempDirectory(directory: string, temporaryRoot: string): boolean {
  const resolvedDirectory = path.resolve(directory);
  const resolvedRoot = path.resolve(temporaryRoot);
  const samePath = (left: string, right: string) => process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  return samePath(path.dirname(resolvedDirectory), resolvedRoot)
    && path.basename(resolvedDirectory).startsWith(HELPER_PREFIX);
}

async function removeCreatedHelperDirectory(
  directory: string,
  temporaryRoot: string,
  canonicalDirectory: string | null,
  identity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null,
): Promise<void> {
  if (!identity || !canonicalDirectory || !ownedTempDirectory(canonicalDirectory, temporaryRoot)) return;
  try {
    const currentCanonical = await realpath(directory);
    const sameCanonical = process.platform === "win32"
      ? currentCanonical.toLowerCase() === canonicalDirectory.toLowerCase()
      : currentCanonical === canonicalDirectory;
    if (!sameCanonical) return;
    const current = await lstat(currentCanonical, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) return;
    await rm(currentCanonical, { recursive: true, force: true });
  } catch {
    // Uncertain identity means retain the private directory for manual cleanup.
  }
}

async function prepareWindowsHelper(): Promise<void> {
  if (helperExecutable) return;
  const windir = process.env.WINDIR || "C:\\Windows";
  if (!isAbsoluteWindowsPath(windir)) throw new Error("Windows plugin worker process ownership is unavailable.");
  const compiler = path.win32.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const sourcePath = fileURLToPath(new URL("../native-runtime/windows-job-supervisor/WindowsJobSupervisor.cs", import.meta.url));
  const temporaryRoot = path.resolve(tmpdir());
  let directory: string | null = null;
  let canonicalDirectory: string | null = null;
  let directoryIdentity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null = null;
  try {
    await access(compiler);
    await access(sourcePath);
    directory = await mkdtemp(path.join(temporaryRoot, HELPER_PREFIX));
    const initialDirectory = await lstat(directory, { bigint: true });
    if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink()) throw new Error("Invalid private helper directory.");
    directoryIdentity = { dev: initialDirectory.dev, ino: initialDirectory.ino, birthtimeNs: initialDirectory.birthtimeNs };
    const resolvedDirectory = await realpath(directory);
    const canonicalMatches = process.platform === "win32"
      ? path.resolve(directory).toLowerCase() === resolvedDirectory.toLowerCase()
      : path.resolve(directory) === resolvedDirectory;
    if (!ownedTempDirectory(resolvedDirectory, temporaryRoot) || !canonicalMatches) {
      throw new Error("Invalid private helper directory.");
    }
    canonicalDirectory = resolvedDirectory;
    const canonicalDirectoryStat = await lstat(resolvedDirectory, { bigint: true });
    if (!canonicalDirectoryStat.isDirectory() || canonicalDirectoryStat.isSymbolicLink()
      || canonicalDirectoryStat.dev !== directoryIdentity.dev || canonicalDirectoryStat.ino !== directoryIdentity.ino
      || canonicalDirectoryStat.birthtimeNs !== directoryIdentity.birthtimeNs) {
      throw new Error("Invalid private helper directory.");
    }
    const outputPath = path.join(resolvedDirectory, "SpsCorePluginWorkerSupervisor.exe");
    await execFile(compiler, [
      "/nologo", "/optimize+", "/platform:x64", "/target:exe", "/reference:System.Web.Extensions.dll",
      `/out:${outputPath}`, sourcePath,
    ], { windowsHide: true, shell: false, timeout: COMPILE_TIMEOUT_MS, maxBuffer: COMPILE_MAX_BUFFER });
    await access(outputPath);
    const completedDirectoryPath = await realpath(directory);
    const completedDirectory = await lstat(completedDirectoryPath, { bigint: true });
    const sameCompletedPath = process.platform === "win32"
      ? completedDirectoryPath.toLowerCase() === resolvedDirectory.toLowerCase()
      : completedDirectoryPath === resolvedDirectory;
    if (!sameCompletedPath || !completedDirectory.isDirectory() || completedDirectory.isSymbolicLink()
      || completedDirectory.dev !== directoryIdentity.dev || completedDirectory.ino !== directoryIdentity.ino
      || completedDirectory.birthtimeNs !== directoryIdentity.birthtimeNs) {
      throw new Error("Invalid private helper directory.");
    }
    helperExecutable = outputPath;
    // Keep the uniquely-created private helper directory for this Core process
    // lifetime. Windows can keep the executable loaded while workers are being
    // torn down, so asynchronous exit cleanup cannot safely prove it is still
    // deleting the same directory it created.
  } catch {
    if (directory) await removeCreatedHelperDirectory(directory, temporaryRoot, canonicalDirectory, directoryIdentity);
    throw new Error("Windows plugin worker process ownership could not be prepared.");
  }
}

function beginWindowsPreparation(): void | Promise<void> {
  if (process.platform !== "win32") return;
  if (helperExecutable) return;
  if (!helperPreparation) {
    const pending = prepareWindowsHelper().catch(error => {
      if (helperPreparation === pending) helperPreparation = null;
      throw error;
    });
    helperPreparation = pending;
  }
  return helperPreparation;
}

/**
 * Prepares the Windows process-tree helper without starting a worker. This
 * intentionally returns synchronously on POSIX and after prior Windows prep.
 */
/** Testable internal adapter factory; product code uses the module functions. */
export function createPluginWorkerProcessAdapter(dependencies: AdapterDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const fork = dependencies.fork ?? nodeFork;
  const spawnWindows = dependencies.spawnWindows ?? ((invocation, internal) =>
    spawnWindowsJobSupervisor(invocation, internal) as SupervisedChild);
  const prepare = dependencies.prepareWindowsHelper ?? beginWindowsPreparation;
  const helperPath = dependencies.windowsHelperPath ?? (() => helperExecutable);
  const execPath = dependencies.execPath ?? process.execPath;
  const getCwd = dependencies.cwd ?? (() => process.cwd());
  let prepared = platform !== "win32";
  let preparation: Promise<void> | null = null;
  const ownership = new WeakMap<ChildProcess, PluginWorkerProcessOwnership>();

  function prepareWorkerProcess(): void | Promise<void> {
    if (platform !== "win32" || prepared) return;
    if (preparation) return preparation;
    const result = prepare();
    if (result && typeof (result as Promise<void>).then === "function") {
      const pending = Promise.resolve(result).then(() => {
        prepared = true;
      }).finally(() => {
        if (preparation === pending) preparation = null;
      });
      preparation = pending;
      return pending;
    }
    prepared = true;
  }

  function spawnWorkerProcess(entrypointPath: string, options: PluginWorkerProcessOptions): ChildProcess {
    assertWorkerOptions(entrypointPath, options, platform);
    if (platform !== "win32") {
      return fork(entrypointPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        execArgv: [...options.execArgv],
        env: { ...options.env },
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    }
    if (!prepared) throw new Error("Windows plugin worker process ownership is not prepared.");
    const helper = helperPath();
    const cwd = options.cwd ?? getCwd();
    if (!helper || !isAbsoluteWindowsPath(helper) || !isAbsoluteWindowsPath(entrypointPath)
      || !isAbsoluteWindowsPath(execPath) || !isAbsoluteWindowsPath(cwd)) {
      throw new Error("Windows plugin worker process ownership is unavailable.");
    }
    const invocation: WindowsJobSupervisorInvocation = {
      executable: execPath,
      cwd,
      args: [...options.execArgv, entrypointPath],
      env: windowsWorkerEnvironment(options.env),
    };
    const child = spawnWindows(invocation, { helperPath: helper, platform });
    let closed = false;
    let targetPid: number | null = null;
    let closure: Promise<unknown> | null = null;
    const processClosed = new Promise<void>(resolve => child.once("close", () => {
      resolve();
    }));
    const ready = Promise.resolve(child.supervisorReady).then(pid => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Windows plugin worker target identity is invalid.");
      targetPid = pid;
    });
    void ready.catch(() => undefined);
    const owned: PluginWorkerProcessOwnership = Object.freeze({
      ready,
      terminate: () => child.terminateOwnedJob(),
      async waitForClosure() {
        if (!closure) {
          closure = (async () => {
            const terminal = await child.waitForOwnedJobTermination();
            await processClosed;
            closed = true;
            return terminal;
          })();
          void closure.catch(() => undefined);
        }
        return closure;
      },
      hasUnconfirmed: () => child.hasUnconfirmedOwnedJobTermination(),
      processId: () => closed ? null : targetPid,
    });
    ownership.set(child, owned);
    return child;
  }

  function getOwnership(child: ChildProcess): PluginWorkerProcessOwnership | null {
    return ownership.get(child) ?? null;
  }

  return Object.freeze({
    preparePluginWorkerProcess: prepareWorkerProcess,
    spawnPluginWorkerProcess: spawnWorkerProcess,
    getPluginWorkerProcessOwnership: getOwnership,
  });
}

const pluginWorkerProcessAdapter = createPluginWorkerProcessAdapter();

export const spawnPluginWorkerProcess = pluginWorkerProcessAdapter.spawnPluginWorkerProcess;
export const getPluginWorkerProcessOwnership = pluginWorkerProcessAdapter.getPluginWorkerProcessOwnership;
export const preparePluginWorkerProcess = pluginWorkerProcessAdapter.preparePluginWorkerProcess;
