import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

export type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  process?: ChildProcess;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  postgresFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
  startupTermination?: EmbeddedPostgresStartupTermination;
  startupSqlState?: EmbeddedPostgresStartupSqlState;
  startupPidFileFailure?: EmbeddedPostgresPidFileFailure;
};

export type EmbeddedPostgresStartupTermination = { kind: "exit"; code: number } | { kind: "signal" };
export type EmbeddedPostgresStartupSqlState = "22023" | "28P01" | "3D000" | "42501" | "53100" | "53200" | "53300"
  | "53400" | "55000" | "55P03" | "57P03" | "58030" | "58P01" | "58P02" | "F0000" | "F0001"
  | "XX000" | "XX001" | "XX002";
export type EmbeddedPostgresPidFileFailure = "pid_invalid" | "pid_mismatch" | "started_at_invalid" | "started_at_mismatch"
  | "data_directory_not_absolute" | "data_directory_unresolvable" | "data_directory_mismatch" | "port_mismatch"
  | "pid_file_unavailable" | "pid_file_not_regular";
export type EmbeddedPostgresShutdownPhase = "none" | "fast_shutdown_received" | "transactions_aborting"
  | "shutdown_checkpoint_starting" | "shutdown_checkpoint_complete" | "database_shutdown_complete";

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

export type EmbeddedPostgresStartupStage = "prepare" | "initdb" | "postgres_start" | "create_database" | "migrations";
export type EmbeddedPostgresFailureCategory = "process_exited_before_ready" | "process_signaled_before_ready" | "initdb_failed" | "permission_denied"
  | "port_in_use" | "binary_unavailable" | "root_user_unsupported" | "database_unavailable" | "other";

export type FixtureIdentity = { canonicalPath: string; dev: bigint; ino: bigint; birthtimeNs: bigint;
  postmaster?: { pid: number; startedAt: number } };

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as unknown as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const dataDirIdentity = await captureFixtureIdentity(dataDir);
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const shutdownObserver = createEmbeddedPostgresShutdownPhaseObserver();
  const sqlStateObserver = createEmbeddedPostgresStartupSqlStateObserver();
  const startupDiagnostics: { logCategory: EmbeddedPostgresFailureCategory | null; shutdownPhase: () => EmbeddedPostgresShutdownPhase;
    sqlState: () => EmbeddedPostgresStartupSqlState | undefined; resetSqlState: () => void } = {
    logCategory: null,
    shutdownPhase: shutdownObserver.phase,
    sqlState: sqlStateObserver.sqlState,
    resetSqlState: sqlStateObserver.reset,
  };
  const observe = (value: unknown) => {
    startupDiagnostics.logCategory = embeddedPostgresLogCategory(value) ?? startupDiagnostics.logCategory;
    shutdownObserver.observe(value);
    sqlStateObserver.observe(value);
  };
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    postgresFlags: ["-c", "log_error_verbosity=verbose"],
    onLog: observe,
    onError: observe,
  });

  return { dataDir, dataDirIdentity, port, instance, startupDiagnostics };
}

const POSTGRES_LOG_TAIL_LIMIT = 16_384;
const POSTGRES_SQLSTATE_CARRY_LIMIT = 512;
const EMBEDDED_POSTGRES_STARTUP_SQLSTATES = new Set<EmbeddedPostgresStartupSqlState>([
  "22023", // invalid_parameter_value
  "28P01", // invalid_password
  "3D000", // invalid_catalog_name
  "42501", // insufficient_privilege
  "53100", // disk_full
  "53200", // out_of_memory
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "55000", // object_not_in_prerequisite_state
  "55P03", // lock_not_available
  "57P03", // cannot_connect_now
  "58030", // io_error
  "58P01", // undefined_file
  "58P02", // duplicate_file
  "F0000", // config_file_error
  "F0001", // lock_file_exists
  "XX000", // internal_error
  "XX001", // data_corrupted
  "XX002", // index_corrupted
]);

/** Retains only a bounded private tail to recognize fixed PostgreSQL shutdown markers. */
export function createEmbeddedPostgresShutdownPhaseObserver(): {
  observe(value: unknown): void;
  phase(): EmbeddedPostgresShutdownPhase;
} {
  let tail = "";
  let tailStartOffset = 0;
  let totalLength = 0;
  let shutdownCheckpointStartOffset = -1;
  let phase: EmbeddedPostgresShutdownPhase = "none";
  const matchOffsets = (value: string, pattern: RegExp): number[] =>
    [...value.matchAll(pattern)].map(match => tailStartOffset + (match.index ?? 0));
  const advance = (next: EmbeddedPostgresShutdownPhase) => {
    const order: EmbeddedPostgresShutdownPhase[] = ["none", "fast_shutdown_received", "transactions_aborting",
      "shutdown_checkpoint_starting", "shutdown_checkpoint_complete", "database_shutdown_complete"];
    if (order.indexOf(next) > order.indexOf(phase)) phase = next;
  };
  return {
    observe(value) {
      if (typeof value !== "string") return;
      const boundedChunk = value.slice(-POSTGRES_LOG_TAIL_LIMIT);
      totalLength += value.length;
      const combined = `${tail}${boundedChunk}`;
      tail = combined.slice(-POSTGRES_LOG_TAIL_LIMIT);
      tailStartOffset = totalLength - tail.length;
      const diagnostic = tail.toLowerCase();
      if (/received fast shutdown request/.test(diagnostic)) advance("fast_shutdown_received");
      if (/aborting any active transactions/.test(diagnostic)) advance("transactions_aborting");
      const shutdownStarts = matchOffsets(diagnostic, /checkpoint starting:\s*shutdown/g);
      if (shutdownStarts.length) shutdownCheckpointStartOffset = shutdownStarts[shutdownStarts.length - 1]!;
      if (shutdownCheckpointStartOffset >= 0) advance("shutdown_checkpoint_starting");
      const checkpointCompletes = matchOffsets(diagnostic, /checkpoint complete/g);
      if (shutdownCheckpointStartOffset >= 0 && checkpointCompletes.some(offset => offset > shutdownCheckpointStartOffset)) {
        advance("shutdown_checkpoint_complete");
      }
      if (/database system is shut down/.test(diagnostic)) advance("database_shutdown_complete");
    },
    phase: () => phase,
  };
}

/** Retains only a bounded suffix and a fixed allowlisted SQLSTATE from verbose startup errors. */
export function createEmbeddedPostgresStartupSqlStateObserver(): {
  observe(value: unknown): void;
  reset(): void;
  sqlState(): EmbeddedPostgresStartupSqlState | undefined;
  bufferedLength(): number;
} {
  let carry = "";
  let state: EmbeddedPostgresStartupSqlState | undefined;
  return {
    observe(value) {
      if (typeof value !== "string") return;
      const diagnostic = carry + value.slice(-POSTGRES_LOG_TAIL_LIMIT);
      const matches = diagnostic.matchAll(/(?:^|\r?\n)[^\r\n]{0,256}\b(?:FATAL|PANIC):\s*([A-Z0-9]{5}):/g);
      for (const match of matches) {
        const candidate = match[1] as EmbeddedPostgresStartupSqlState;
        if (EMBEDDED_POSTGRES_STARTUP_SQLSTATES.has(candidate)) state = candidate;
      }
      carry = diagnostic.slice(-POSTGRES_SQLSTATE_CARRY_LIMIT);
    },
    reset() {
      carry = "";
      state = undefined;
    },
    sqlState: () => state,
    bufferedLength: () => carry.length,
  };
}

async function captureFixtureIdentity(dataDir: string): Promise<FixtureIdentity> {
  const [canonicalPath, info] = await Promise.all([
    fs.promises.realpath(dataDir),
    fs.promises.lstat(dataDir, { bigint: true }),
  ]);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Embedded PostgreSQL test fixture root is not an owned directory.");
  return { canonicalPath, dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs };
}

async function assertFixtureIdentity(dataDir: string, expected: FixtureIdentity) {
  const [canonicalPath, info] = await Promise.all([
    fs.promises.realpath(dataDir),
    fs.promises.lstat(dataDir, { bigint: true }),
  ]);
  if (!info.isDirectory() || info.isSymbolicLink()
    || normalizedPath(canonicalPath) !== normalizedPath(expected.canonicalPath)
    || info.dev !== expected.dev || info.ino !== expected.ino || info.birthtimeNs !== expected.birthtimeNs) {
    throw new Error("Embedded PostgreSQL test fixture directory identity changed; preserving it.");
  }
}

async function cleanupEmbeddedPostgresTestDirs(dataDir: string, identity: FixtureIdentity) {
  // Windows can retain the Postgres data-directory handle briefly after stop().
  // `rm` retries the documented transient EPERM/EBUSY cases before surfacing a
  // real cleanup failure to the test that owns the database.
  for (let attempt = 0; attempt < 9; attempt++) {
    await assertFixtureIdentity(dataDir, identity);
    try {
      await fs.promises.rm(dataDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(["EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) || attempt === 8) throw error;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

function embeddedPostgresNativePackageName(): string {
  const platform = process.platform;
  const architecture = process.arch;
  const suffix = platform === "win32" ? "windows" : platform;
  const arch = architecture === "arm64" ? "arm64" : architecture === "ia32" ? "ia32" : architecture;
  return `@embedded-postgres/${suffix}-${arch}`;
}

async function resolvePgCtlPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const embeddedEntry = require.resolve("embedded-postgres");
  const embeddedRequire = createRequire(embeddedEntry);
  const binaryOverride = process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR;
  if (binaryOverride && path.isAbsolute(binaryOverride)) {
    const overridden = path.join(binaryOverride, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
    if (fs.existsSync(overridden)) return overridden;
  }
  const nativeEntry = embeddedRequire.resolve(embeddedPostgresNativePackageName());
  const nativePackage = await import(pathToFileURL(nativeEntry).href) as { pg_ctl?: unknown };
  if (typeof nativePackage.pg_ctl !== "string" || !path.isAbsolute(nativePackage.pg_ctl)) {
    throw new Error("Embedded PostgreSQL pg_ctl binary is unavailable.");
  }
  return nativePackage.pg_ctl;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replaceAll("/", "\\");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function inspectPostmasterDataDirectory(
  recordedDirectory: unknown,
  canonicalFixtureDirectory: string,
  resolvePath: (value: string) => Promise<string> = value => fs.promises.realpath(value),
): Promise<"matches" | "unresolvable" | "mismatch"> {
  if (typeof recordedDirectory !== "string" || !path.isAbsolute(recordedDirectory)
    || !path.isAbsolute(canonicalFixtureDirectory)) return "mismatch";
  try {
    const resolvedRecordedDirectory = await resolvePath(recordedDirectory);
    return path.isAbsolute(resolvedRecordedDirectory)
      && normalizedPath(resolvedRecordedDirectory) === normalizedPath(canonicalFixtureDirectory) ? "matches" : "mismatch";
  } catch {
    return "unresolvable";
  }
}

/** Resolves Windows 8.3/long-path aliases only when they identify this canonical fixture. */
export async function postmasterDataDirectoryMatches(
  recordedDirectory: unknown,
  canonicalFixtureDirectory: string,
  resolvePath?: (value: string) => Promise<string>,
): Promise<boolean> {
  return await inspectPostmasterDataDirectory(recordedDirectory, canonicalFixtureDirectory, resolvePath) === "matches";
}

export async function validateOwnedPostmasterPidFile(
  contents: string,
  port: number,
  canonicalFixtureDirectory: string,
  expectedIdentity?: { pid: number; startedAt: number },
  expectedChildPid?: number,
  resolvePath?: (value: string) => Promise<string>,
): Promise<{ pid: number; startedAt: number }> {
  if (expectedChildPid === undefined && expectedIdentity === undefined) throw postmasterPidFileFailure("pid_mismatch");
  const lines = contents.split(/\r?\n/);
  const pid = Number(lines[0]);
  const recordedDir = lines[1];
  const startedAt = Number(lines[2]);
  const recordedPort = Number(lines[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw postmasterPidFileFailure("pid_invalid");
  const requiredPid = expectedChildPid ?? expectedIdentity?.pid;
  if ((expectedChildPid !== undefined && (!Number.isSafeInteger(expectedChildPid) || expectedChildPid <= 0))
    || (requiredPid !== undefined && pid !== requiredPid)) throw postmasterPidFileFailure("pid_mismatch");
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw postmasterPidFileFailure("started_at_invalid");
  if (expectedIdentity && startedAt !== expectedIdentity.startedAt) throw postmasterPidFileFailure("started_at_mismatch");
  if (typeof recordedDir !== "string" || !path.isAbsolute(recordedDir)) throw postmasterPidFileFailure("data_directory_not_absolute");
  const directoryCheck = await inspectPostmasterDataDirectory(recordedDir, canonicalFixtureDirectory, resolvePath);
  if (directoryCheck !== "matches") throw postmasterPidFileFailure(
    directoryCheck === "unresolvable" ? "data_directory_unresolvable" : "data_directory_mismatch",
  );
  if (!Number.isSafeInteger(port) || recordedPort !== port) throw postmasterPidFileFailure("port_mismatch");
  return { pid, startedAt };
}

function postmasterPidFileFailure(code: EmbeddedPostgresPidFileFailure): Error {
  return Object.assign(new Error(`Embedded PostgreSQL test pid file validation failed (${code}).`), {
    code: `SPS_PG_PIDFILE_${code.toUpperCase()}`,
  });
}

function embeddedPostgresPidFileFailure(error: unknown): EmbeddedPostgresPidFileFailure | undefined {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "";
  const match = /^SPS_PG_PIDFILE_([A-Z_]+)$/.exec(code);
  const failure = match?.[1]?.toLowerCase();
  const failures: readonly EmbeddedPostgresPidFileFailure[] = ["pid_invalid", "pid_mismatch", "started_at_invalid", "started_at_mismatch",
    "data_directory_not_absolute", "data_directory_unresolvable", "data_directory_mismatch", "port_mismatch",
    "pid_file_unavailable", "pid_file_not_regular"];
  return failures.find(value => value === failure);
}

async function readOwnedPostmasterPidFile(dataDir: string, port: number, fixture: FixtureIdentity) {
  const canonicalDataDir = await fs.promises.realpath(dataDir);
  await assertFixtureIdentity(dataDir, fixture);
  if (normalizedPath(canonicalDataDir) !== normalizedPath(fixture.canonicalPath)) {
    throw new Error("Embedded PostgreSQL test data directory changed its canonical path.");
  }
  const pidFile = path.join(dataDir, "postmaster.pid");
  let info;
  try { info = await fs.promises.lstat(pidFile); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw postmasterPidFileFailure("pid_file_not_regular");
  let contents: string;
  try { contents = await fs.promises.readFile(pidFile, "utf8"); }
  catch { throw postmasterPidFileFailure("pid_file_unavailable"); }
  if (!fixture.postmaster) throw postmasterPidFileFailure("pid_mismatch");
  const identity = await validateOwnedPostmasterPidFile(contents, port, canonicalDataDir, fixture.postmaster);
  return { pidFile, pid: identity.pid };
}

async function captureOwnedPostmasterIdentity(dataDir: string, port: number, fixture: FixtureIdentity, childPid: number | undefined) {
  await assertFixtureIdentity(dataDir, fixture);
  const pidFile = path.join(dataDir, "postmaster.pid");
  let info;
  try { info = await fs.promises.lstat(pidFile); }
  catch { throw postmasterPidFileFailure("pid_file_unavailable"); }
  if (!info.isFile() || info.isSymbolicLink()) throw postmasterPidFileFailure("pid_file_not_regular");
  let contents: string;
  try { contents = await fs.promises.readFile(pidFile, "utf8"); }
  catch { throw postmasterPidFileFailure("pid_file_unavailable"); }
  if (!Number.isSafeInteger(childPid) || childPid === undefined || childPid <= 0) throw postmasterPidFileFailure("pid_mismatch");
  fixture.postmaster = await validateOwnedPostmasterPidFile(contents, port, fixture.canonicalPath, undefined, childPid);
}

type OwnedChildTerminalPhase = "already_closed" | "close_observed" | "error_observed" | "not_observed";

function observeOwnedProcessClose(child: ChildProcess | undefined): {
  promise: Promise<void>;
  dispose(): void;
  terminalPhase(): OwnedChildTerminalPhase;
} {
  if (!child || childFullyClosed(child)) return { promise: Promise.resolve(), dispose() {}, terminalPhase: () => "already_closed" };
  let phase: OwnedChildTerminalPhase = "not_observed";
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      phase = error ? "error_observed" : "close_observed";
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish();
    cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };
    child.once("error", onError);
    child.once("close", onClose);
  });
  // Mark the observer rejection handled immediately while shutdown setup is
  // still running; the original promise is awaited below to propagate failure.
  void promise.catch(() => {});
  return { promise, dispose: () => cleanup(), terminalPhase: () => phase };
}

function childFullyClosed(child: ChildProcess): boolean {
  if (child.exitCode === null && child.signalCode === null) return false;
  const streams = child.stdio?.filter(stream => stream !== null) ?? [];
  if (streams.length === 0) return child.connected === false;
  return child.connected === false && streams.every(stream =>
    (stream as { destroyed?: boolean }).destroyed === true);
}

async function waitForOwnedProcessClose(closePromise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closePromise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Embedded PostgreSQL test process did not close after shutdown.")), 20_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function stopEmbeddedPostgresTestInstance(
  dataDir: string,
  port: number,
  instance: EmbeddedPostgresInstance,
  fixture: FixtureIdentity,
  dependencies: { resolvePgCtl?: () => Promise<string>; spawnPgCtl?: typeof spawn; shutdownPhase?: () => EmbeddedPostgresShutdownPhase } = {},
) {
  const child = (instance as unknown as { process?: ChildProcess }).process;
  const childClose = observeOwnedProcessClose(child);
  try {
    const owned = await readOwnedPostmasterPidFile(dataDir, port, fixture);
    if (owned) {
      const pgCtl = await (dependencies.resolvePgCtl ?? resolvePgCtlPath)();
      await new Promise<void>((resolve, reject) => {
        const outputTailLimit = 4096;
        let stdoutTail = Buffer.alloc(0), stderrTail = Buffer.alloc(0);
        let stdoutBytes = 0, stderrBytes = 0;
        const process = (dependencies.spawnPgCtl ?? spawn)(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        const appendTail = (current: Buffer, chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          if (value.length >= outputTailLimit) return Buffer.from(value.subarray(value.length - outputTailLimit));
          const retainedCurrent = current.subarray(Math.max(0, current.length - (outputTailLimit - value.length)));
          return retainedCurrent.length ? Buffer.concat([retainedCurrent, value]) : Buffer.from(value);
        };
        const onStdout = (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, stdoutBytes + value.length);
          stdoutTail = appendTail(stdoutTail, value);
        };
        const onStderr = (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + value.length);
          stderrTail = appendTail(stderrTail, value);
        };
        process.stdout?.on("data", onStdout);
        process.stderr?.on("data", onStderr);
        const cleanup = () => {
          clearTimeout(timer);
          process.stdout?.removeListener("data", onStdout);
          process.stderr?.removeListener("data", onStderr);
          process.removeListener("error", onError);
          process.removeListener("close", onClose);
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = (code: number | null) => {
          cleanup();
          if (code === 0) resolve();
          else {
            const diagnostic = `${stdoutTail.toString("utf8")}\n${stderrTail.toString("utf8")}`;
            void (async () => {
              let ownedPidFileState: "present" | "absent" | "changed_or_unverified";
              try {
                ownedPidFileState = await readOwnedPostmasterPidFile(dataDir, port, fixture) ? "present" : "absent";
              } catch {
                ownedPidFileState = "changed_or_unverified";
              }
              const postgresTermination = embeddedPostgresStartupTermination(child);
              const terminationSummary = postgresTermination?.kind === "exit" ? `exit:${postgresTermination.code}`
                : postgresTermination?.kind === "signal" ? "signal" : "running_or_unobserved";
              const shutdownPhase = dependencies.shutdownPhase?.() ?? "none";
              reject(new Error(`Embedded PostgreSQL test pg_ctl shutdown failed (exitCode=${code}; category=${classifyPgCtlFailure(diagnostic)}; stdoutBytes=${stdoutBytes}; stderrBytes=${stderrBytes}; ownedPidFileState=${ownedPidFileState}; childTerminalPhase=${childClose.terminalPhase()}; postgresShutdownPhase=${shutdownPhase}; postgresTermination=${terminationSummary}); fixture preserved.`));
            })();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          try { process.kill(); } catch { /* This is only the pg_ctl child created above. */ }
          const postgresTermination = embeddedPostgresStartupTermination(child);
          const terminationSummary = postgresTermination?.kind === "exit" ? `exit:${postgresTermination.code}`
            : postgresTermination?.kind === "signal" ? "signal" : "running_or_unobserved";
          reject(new Error(`Embedded PostgreSQL test pg_ctl shutdown timed out (postgresShutdownPhase=${dependencies.shutdownPhase?.() ?? "none"}; postgresTermination=${terminationSummary}); preserving fixture data.`));
        }, 25_000);
        process.once("error", onError);
        process.once("close", onClose);
      });
      if (fs.existsSync(owned.pidFile)) throw new Error("Embedded PostgreSQL test pid file remained after pg_ctl shutdown.");
    } else if (child && !childFullyClosed(child)) {
      throw new Error("Embedded PostgreSQL test has a live process but no verified fixture pid file; preserving it.");
    } else if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
      throw new Error("Embedded PostgreSQL test pid file remains without a verified running fixture; preserving it.");
    }
    await waitForOwnedProcessClose(childClose.promise);
    // embedded-postgres registers process-exit cleanup for every instance. The
    // graceful pg_ctl path has already stopped and reaped this exact child; clear
    // its stale handle so the package hook cannot wait for an already-fired exit.
    (instance as unknown as { process?: ChildProcess }).process = undefined;
  } finally {
    childClose.dispose();
  }
}

/** Maps private startup diagnostics to fixed categories; never returns messages or paths. */
export function classifyEmbeddedPostgresFailure(
  error: unknown,
  observedLogCategory: EmbeddedPostgresFailureCategory | null,
  stage: EmbeddedPostgresStartupStage,
  startupTermination?: EmbeddedPostgresStartupTermination,
): EmbeddedPostgresFailureCategory {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 32) : "";
  const message = typeof error === "string" ? error.slice(0, 16_384)
    : error instanceof Error ? error.message.slice(0, 16_384) : "";
  const diagnostic = `${code} ${message}`.toLowerCase();
  if (/eacces|eperm|access is denied|permission denied|operation not permitted/.test(diagnostic)) return "permission_denied";
  if (/eaddrinuse|address already in use|could not bind|failed to bind/.test(diagnostic)) return "port_in_use";
  if (/enoent|could not load library|specified module could not be found|dll was not found/.test(diagnostic)) return "binary_unavailable";
  if (/cannot run as a root user|root user/.test(diagnostic)) return "root_user_unsupported";
  if (/init script exited with code|initdb.*exited/.test(diagnostic)) return "initdb_failed";
  if (/connection refused|could not connect to server|database system is not accepting/.test(diagnostic)) return "database_unavailable";
  if (observedLogCategory && observedLogCategory !== "other") return observedLogCategory;
  if (stage === "postgres_start" && error === undefined) {
    if (startupTermination?.kind === "signal") return "process_signaled_before_ready";
    if (startupTermination?.kind === "exit" && isWindowsLoaderFailureCode(startupTermination.code)) return "binary_unavailable";
    return "process_exited_before_ready";
  }
  return "other";
}

const WINDOWS_LOADER_FAILURE_CODES = new Set([0xc0000135, 0xc0000139, 0xc000007b]);

function isWindowsLoaderFailureCode(code: number): boolean {
  return Number.isSafeInteger(code) && code >= -0x80000000 && code <= 0xffffffff
    && WINDOWS_LOADER_FAILURE_CODES.has(code >>> 0);
}

/** Snapshots only fixed child termination data; never retains process output or arbitrary error fields. */
export function embeddedPostgresStartupTermination(
  child: Pick<ChildProcess, "exitCode" | "signalCode"> | undefined,
): EmbeddedPostgresStartupTermination | undefined {
  if (!child) return undefined;
  if (child.signalCode !== null && child.signalCode !== undefined) return { kind: "signal" };
  const code = child.exitCode;
  if (typeof code === "number" && Number.isSafeInteger(code) && code >= -0x80000000 && code <= 0xffffffff) {
    return { kind: "exit", code };
  }
  return undefined;
}

export function embeddedPostgresSupportResult(
  startupFailed: boolean,
  error: unknown,
  observedLogCategory: EmbeddedPostgresFailureCategory | null,
  stage: EmbeddedPostgresStartupStage,
  startupTermination?: EmbeddedPostgresStartupTermination,
  startupSqlState?: EmbeddedPostgresStartupSqlState,
  startupPidFileFailure?: EmbeddedPostgresPidFileFailure,
): EmbeddedPostgresTestSupport {
  if (!startupFailed) return { supported: true };
  const category = classifyEmbeddedPostgresFailure(error, observedLogCategory, stage, startupTermination);
  return {
    supported: false,
    reason: `embedded Postgres ${stage} failed (${category})`,
    ...(stage === "postgres_start" && startupTermination ? { startupTermination } : {}),
    ...(stage === "postgres_start" && isEmbeddedPostgresStartupSqlState(startupSqlState) ? { startupSqlState } : {}),
    ...(stage === "postgres_start" && startupPidFileFailure ? { startupPidFileFailure } : {}),
  };
}

/** Formats only the fixed failure fields accepted from a test-support result. */
export function formatEmbeddedPostgresTestSupportFailure(support: EmbeddedPostgresTestSupport): string {
  if (support.supported) return "embedded Postgres test support is available";
  const match = typeof support.reason === "string"
    ? /^embedded Postgres (prepare|initdb|postgres_start|create_database|migrations) failed \((process_exited_before_ready|process_signaled_before_ready|initdb_failed|permission_denied|port_in_use|binary_unavailable|root_user_unsupported|database_unavailable|other)\)$/.exec(support.reason)
    : null;
  if (!match) return "embedded Postgres support probe unavailable";
  const [, stage, category] = match;
  let message = `embedded Postgres ${stage} failed (${category})`;
  if (stage === "postgres_start") {
    const termination = support.startupTermination;
    if (termination?.kind === "exit" && Number.isSafeInteger(termination.code)
      && termination.code >= -0x80000000 && termination.code <= 0xffffffff) {
      message += `; child_exit=${termination.code}`;
    } else if (termination?.kind === "signal") {
      message += "; child_signaled";
    }
    if (isEmbeddedPostgresStartupSqlState(support.startupSqlState)) {
      message += `; sqlstate=${support.startupSqlState}`;
    }
    if (isEmbeddedPostgresPidFileFailure(support.startupPidFileFailure)) {
      message += `; pidfile=${support.startupPidFileFailure}`;
    }
  }
  return message;
}

function isEmbeddedPostgresStartupSqlState(value: unknown): value is EmbeddedPostgresStartupSqlState {
  return typeof value === "string" && EMBEDDED_POSTGRES_STARTUP_SQLSTATES.has(value as EmbeddedPostgresStartupSqlState);
}

function isEmbeddedPostgresPidFileFailure(value: unknown): value is EmbeddedPostgresPidFileFailure {
  return value === "pid_invalid" || value === "pid_mismatch" || value === "started_at_invalid" || value === "started_at_mismatch"
    || value === "data_directory_not_absolute" || value === "data_directory_unresolvable" || value === "data_directory_mismatch"
    || value === "port_mismatch" || value === "pid_file_unavailable" || value === "pid_file_not_regular";
}

function embeddedPostgresLogCategory(value: unknown): EmbeddedPostgresFailureCategory | null {
  if (typeof value !== "string") return null;
  const diagnostic = value.slice(0, 16_384).toLowerCase();
  if (/access is denied|permission denied|operation not permitted/.test(diagnostic)) return "permission_denied";
  if (/address already in use|could not bind|failed to bind/.test(diagnostic)) return "port_in_use";
  if (/could not load library|specified module could not be found|dll was not found/.test(diagnostic)) return "binary_unavailable";
  if (/could not connect to server|connection refused|database system is not accepting/.test(diagnostic)) return "database_unavailable";
  return null;
}

export function classifyPgCtlFailure(output: string): "access_denied" | "pid_file" | "server_unavailable" | "signal_failure" | "shutdown_timeout" | "other" {
  const message = output.toLowerCase();
  if (/access is denied|permission denied|operation not permitted/.test(message)) return "access_denied";
  if (/postmaster\.pid|pid file|lock file/.test(message)) return "pid_file";
  if (/no server running|could not connect|connection refused/.test(message)) return "server_unavailable";
  if (/could not send.*signal|failed to send.*signal|kill\(\).*failed/.test(message)) return "signal_failure";
  if (/server does not shut down|timed out waiting for server to shut down|still shutting down|waiting for server to shut down\.{3,}\s*failed/.test(message)) return "shutdown_timeout";
  return "other";
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let dataDir: string | null = null;
  let dataDirIdentity: FixtureIdentity | null = null;
  let port: number | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  let startupFailed = false;
  let startupError: unknown;
  let startupStage: EmbeddedPostgresStartupStage = "prepare";
  let startupDiagnostics: { logCategory: EmbeddedPostgresFailureCategory | null; shutdownPhase: () => EmbeddedPostgresShutdownPhase;
    sqlState: () => EmbeddedPostgresStartupSqlState | undefined; resetSqlState: () => void } | null = null;
  let startupTermination: EmbeddedPostgresStartupTermination | undefined;
  let startupSqlState: EmbeddedPostgresStartupSqlState | undefined;
  let startupPidFileFailure: EmbeddedPostgresPidFileFailure | undefined;

  try {
    const created = await createEmbeddedPostgresTestInstance(
      "paperclip-embedded-postgres-probe-",
    );
    dataDir = created.dataDir;
    dataDirIdentity = created.dataDirIdentity;
    port = created.port;
    instance = created.instance;
    startupDiagnostics = created.startupDiagnostics;
    startupStage = "initdb";
    await instance.initialise();
    startupStage = "postgres_start";
    startupDiagnostics.resetSqlState();
    await instance.start();
    await captureOwnedPostmasterIdentity(dataDir, port, dataDirIdentity, instance.process?.pid);
  } catch (error) {
    startupFailed = true;
    startupError = error;
    if (startupStage === "postgres_start") {
      startupTermination = embeddedPostgresStartupTermination(instance?.process);
      startupSqlState = startupDiagnostics?.sqlState();
      startupPidFileFailure = embeddedPostgresPidFileFailure(error);
    }
  }
  try {
    if (dataDir && dataDirIdentity && port !== null && instance) {
      await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity, {
        shutdownPhase: startupDiagnostics?.shutdownPhase,
      });
      await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
    }
  } catch (cleanupError) {
    if (startupFailed) {
      const diagnostic = embeddedPostgresSupportResult(true, startupError, startupDiagnostics?.logCategory ?? null, startupStage,
        startupTermination, startupSqlState, startupPidFileFailure);
      const safeDiagnostic = formatEmbeddedPostgresTestSupportFailure(diagnostic);
      throw new AggregateError([new Error(safeDiagnostic), cleanupError], `Embedded PostgreSQL support probe failed (${safeDiagnostic}); cleanup also failed.`);
    }
    throw cleanupError;
  }
  return embeddedPostgresSupportResult(startupFailed, startupError, startupDiagnostics?.logCategory ?? null, startupStage,
    startupTermination, startupSqlState, startupPidFileFailure);
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  let dataDir: string | null = null;
  let dataDirIdentity: FixtureIdentity | null = null;
  let port: number | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  let stage: EmbeddedPostgresStartupStage = "prepare";
  let startupDiagnostics: { logCategory: EmbeddedPostgresFailureCategory | null; shutdownPhase: () => EmbeddedPostgresShutdownPhase;
    sqlState: () => EmbeddedPostgresStartupSqlState | undefined; resetSqlState: () => void } | null = null;

  try {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    dataDir = created.dataDir;
    dataDirIdentity = created.dataDirIdentity;
    instance = created.instance;
    port = created.port;
    startupDiagnostics = created.startupDiagnostics;
    stage = "initdb";
    await instance.initialise();
    stage = "postgres_start";
    startupDiagnostics.resetSqlState();
    await instance.start();
    await captureOwnedPostmasterIdentity(dataDir, port, dataDirIdentity, instance.process?.pid);

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    stage = "create_database";
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    stage = "migrations";
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        if (!dataDir || !dataDirIdentity || port === null || !instance) throw new Error("Embedded PostgreSQL test fixture ownership is unavailable.");
        await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity, {
          shutdownPhase: startupDiagnostics?.shutdownPhase,
        });
        await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
      },
    };
  } catch (error) {
    // The vendor's start() rejects without an error value when its child closes
    // before emitting the ready line. Keep only a fixed category from that
    // lifecycle and from recognized log patterns; never retain raw output.
    const startupTermination = stage === "postgres_start" ? embeddedPostgresStartupTermination(instance?.process) : undefined;
    const startupSqlState = stage === "postgres_start" ? startupDiagnostics?.sqlState() : undefined;
    const startupPidFileFailure = stage === "postgres_start" ? embeddedPostgresPidFileFailure(error) : undefined;
    const category = classifyEmbeddedPostgresFailure(error, startupDiagnostics?.logCategory ?? null, stage, startupTermination);
    const sqlStateSuffix = isEmbeddedPostgresStartupSqlState(startupSqlState) ? `; sqlstate=${startupSqlState}` : "";
    const pidFileSuffix = isEmbeddedPostgresPidFileFailure(startupPidFileFailure) ? `; pidfile=${startupPidFileFailure}` : "";
    try {
      if (dataDir && dataDirIdentity && port !== null && instance) {
        await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity, {
          shutdownPhase: startupDiagnostics?.shutdownPhase,
        });
        await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
      }
    } catch (cleanupError) {
      throw new AggregateError([new Error(`Embedded PostgreSQL ${stage} failed (${category})${sqlStateSuffix}${pidFileSuffix}.`), cleanupError],
        `Failed to start embedded PostgreSQL test database (stage=${stage}; category=${category}${sqlStateSuffix}${pidFileSuffix}); fixture cleanup also failed.`);
    }
    throw new Error(`Failed to start embedded PostgreSQL test database (stage=${stage}; category=${category}${sqlStateSuffix}${pidFileSuffix}).`);
  }
}
