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
  helperPreparationDependencies?: HelperPreparationDependencies;
  windowsHelperPath?: () => string | null;
  spawnWindows?: (
    invocation: WindowsJobSupervisorInvocation,
    internal: { helperPath: string; platform: NodeJS.Platform },
  ) => SupervisedChild;
}>;

type PreparationPhase = "compiler_access" | "source_access" | "temp_root" | "helper_directory" | "compile" | "output_validate";
type PreparationErrorCode = "ENOENT" | "EACCES" | "EPERM" | "ETIMEDOUT" | "ENOTDIR" | "EISDIR" | "INVALID_CONFIG" | "COMPILE_FAILED" | "UNKNOWN";

type HelperPreparationDependencies = Readonly<{
  platform?: NodeJS.Platform;
  windir?: string | null;
  temporaryDirectory?: () => string;
  sourcePath?: string;
  pathApi?: typeof path;
  access?: typeof access;
  mkdtemp?: typeof mkdtemp;
  realpath?: typeof realpath;
  lstat?: typeof lstat;
  compile?: (compiler: string, args: string[], options: { windowsHide: true; shell: false; timeout: number; maxBuffer: number }) => Promise<unknown>;
  rm?: typeof rm;
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

function ownedTempDirectory(
  directory: string,
  temporaryRoot: string,
  pathApi: typeof path = path,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolvedDirectory = pathApi.resolve(directory);
  const resolvedRoot = pathApi.resolve(temporaryRoot);
  const samePath = (left: string, right: string) => platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  return samePath(pathApi.dirname(resolvedDirectory), resolvedRoot)
    && pathApi.basename(resolvedDirectory).startsWith(HELPER_PREFIX);
}

async function removeCreatedHelperDirectory(
  directory: string,
  temporaryRoot: string,
  canonicalDirectory: string | null,
  identity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null,
  fs: Pick<HelperPreparationDependencies, "realpath" | "lstat" | "rm"> = {},
  pathApi: typeof path = path,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!identity || !canonicalDirectory || !ownedTempDirectory(canonicalDirectory, temporaryRoot, pathApi, platform)) return;
  try {
    const currentCanonical = await (fs.realpath ?? realpath)(directory);
    const sameCanonical = platform === "win32"
      ? currentCanonical.toLowerCase() === canonicalDirectory.toLowerCase()
      : currentCanonical === canonicalDirectory;
    if (!sameCanonical) return;
    const current = await (fs.lstat ?? lstat)(currentCanonical, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) return;
    await (fs.rm ?? rm)(currentCanonical, { recursive: true, force: true });
  } catch {
    // Uncertain identity means retain the private directory for manual cleanup.
  }
}

function getPreparationErrorCode(error: unknown, phase: PreparationPhase): PreparationErrorCode {
  const rawCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (phase === "compile" && typeof rawCode === "number" && Number.isInteger(rawCode)) return "COMPILE_FAILED";
  if (typeof rawCode === "string" && ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOTDIR", "EISDIR"].includes(rawCode)) {
    return rawCode as PreparationErrorCode;
  }
  if (rawCode === "INVALID_CONFIG") return "INVALID_CONFIG";
  return "UNKNOWN";
}

function preparationError(phase: PreparationPhase, code: PreparationErrorCode): Error {
  return new Error(`Windows plugin worker process ownership could not be prepared. [phase=${phase}, code=${code}]`);
}

async function compileWindowsHelper(dependencies: HelperPreparationDependencies = {}): Promise<string> {
  const platform = dependencies.platform ?? process.platform;
  const pathApi = dependencies.pathApi ?? (platform === "win32" ? path.win32 : path);
  const fs = {
    access: dependencies.access ?? access,
    mkdtemp: dependencies.mkdtemp ?? mkdtemp,
    realpath: dependencies.realpath ?? realpath,
    lstat: dependencies.lstat ?? lstat,
    rm: dependencies.rm ?? rm,
  };
  const windir = dependencies.windir ?? process.env.WINDIR ?? "C:\\Windows";
  let phase: PreparationPhase = "compiler_access";
  let temporaryRoot: string | null = null;
  let directory: string | null = null;
  let canonicalDirectory: string | null = null;
  let directoryIdentity: { dev: bigint; ino: bigint; birthtimeNs: bigint } | null = null;
  try {
    if (!isAbsoluteWindowsPath(windir)) throw Object.assign(new Error(), { code: "INVALID_CONFIG" });
    const compiler = path.win32.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const sourcePath = dependencies.sourcePath
      ?? fileURLToPath(new URL("../native-runtime/windows-job-supervisor/WindowsJobSupervisor.cs", import.meta.url));
    phase = "compiler_access";
    await fs.access(compiler);
    phase = "source_access";
    await fs.access(sourcePath);
    phase = "temp_root";
    const requestedTemporaryRoot = pathApi.resolve((dependencies.temporaryDirectory ?? tmpdir)());
    temporaryRoot = await fs.realpath(requestedTemporaryRoot);
    const temporaryRootStat = await fs.lstat(temporaryRoot, { bigint: true });
    if (!temporaryRootStat.isDirectory() || temporaryRootStat.isSymbolicLink()) throw new Error();
    phase = "helper_directory";
    directory = await fs.mkdtemp(pathApi.join(temporaryRoot, HELPER_PREFIX));
    const initialDirectory = await fs.lstat(directory, { bigint: true });
    if (!initialDirectory.isDirectory() || initialDirectory.isSymbolicLink()) throw new Error();
    directoryIdentity = { dev: initialDirectory.dev, ino: initialDirectory.ino, birthtimeNs: initialDirectory.birthtimeNs };
    const resolvedDirectory = await fs.realpath(directory);
    const canonicalMatches = platform === "win32"
      ? pathApi.resolve(directory).toLowerCase() === resolvedDirectory.toLowerCase()
      : pathApi.resolve(directory) === resolvedDirectory;
    if (!ownedTempDirectory(resolvedDirectory, temporaryRoot, pathApi, platform) || !canonicalMatches) throw new Error();
    canonicalDirectory = resolvedDirectory;
    const canonicalDirectoryStat = await fs.lstat(resolvedDirectory, { bigint: true });
    if (!canonicalDirectoryStat.isDirectory() || canonicalDirectoryStat.isSymbolicLink()
      || canonicalDirectoryStat.dev !== directoryIdentity.dev || canonicalDirectoryStat.ino !== directoryIdentity.ino
      || canonicalDirectoryStat.birthtimeNs !== directoryIdentity.birthtimeNs) throw new Error();
    const outputPath = pathApi.join(resolvedDirectory, "SpsCorePluginWorkerSupervisor.exe");
    const compile = dependencies.compile ?? (async (command, args, options) => execFile(command, args, options));
    phase = "compile";
    await compile(compiler, [
      "/nologo", "/optimize+", "/platform:x64", "/target:exe", "/reference:System.Web.Extensions.dll",
      `/out:${outputPath}`, sourcePath,
    ], { windowsHide: true, shell: false, timeout: COMPILE_TIMEOUT_MS, maxBuffer: COMPILE_MAX_BUFFER });
    phase = "output_validate";
    await fs.access(outputPath);
    const completedDirectoryPath = await fs.realpath(directory);
    const completedDirectory = await fs.lstat(completedDirectoryPath, { bigint: true });
    const sameCompletedPath = platform === "win32"
      ? completedDirectoryPath.toLowerCase() === resolvedDirectory.toLowerCase()
      : completedDirectoryPath === resolvedDirectory;
    if (!sameCompletedPath || !completedDirectory.isDirectory() || completedDirectory.isSymbolicLink()
      || completedDirectory.dev !== directoryIdentity.dev || completedDirectory.ino !== directoryIdentity.ino
      || completedDirectory.birthtimeNs !== directoryIdentity.birthtimeNs) throw new Error();
    return outputPath;
  } catch (error) {
    if (directory && temporaryRoot) {
      await removeCreatedHelperDirectory(directory, temporaryRoot, canonicalDirectory, directoryIdentity, fs, pathApi, platform);
    }
    throw preparationError(phase, getPreparationErrorCode(error, phase));
  }
}

async function prepareWindowsHelper(): Promise<void> {
  if (helperExecutable) return;
  helperExecutable = await compileWindowsHelper();
  // Keep the uniquely-created private helper directory for this Core process
  // lifetime. Windows can keep the executable loaded while workers are being
  // torn down, so asynchronous exit cleanup cannot safely prove it is still
  // deleting the same directory it created.
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
  let preparedHelperPath: string | null = null;
  const prepare = dependencies.prepareWindowsHelper
    ?? (dependencies.helperPreparationDependencies
      ? () => compileWindowsHelper({ ...dependencies.helperPreparationDependencies, platform }).then(helperPath => {
        preparedHelperPath = helperPath;
      })
      : beginWindowsPreparation);
  const helperPath = dependencies.windowsHelperPath ?? (() => preparedHelperPath ?? helperExecutable);
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
