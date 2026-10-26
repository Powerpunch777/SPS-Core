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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

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
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  return { dataDir, dataDirIdentity, port, instance };
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
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Embedded PostgreSQL test pid file is not an owned regular file.");
  const lines = (await fs.promises.readFile(pidFile, "utf8")).split(/\r?\n/);
  const pid = Number(lines[0]);
  const recordedDir = lines[1];
  const startedAt = Number(lines[2]);
  const recordedPort = Number(lines[3]);
  if (!fixture.postmaster || !Number.isSafeInteger(pid) || pid !== fixture.postmaster.pid
    || !Number.isSafeInteger(startedAt) || startedAt !== fixture.postmaster.startedAt
    || typeof recordedDir !== "string" || normalizedPath(recordedDir) !== normalizedPath(canonicalDataDir)
    || recordedPort !== port) {
    throw new Error("Embedded PostgreSQL test pid file does not match this fixture.");
  }
  return { pidFile, pid };
}

async function captureOwnedPostmasterIdentity(dataDir: string, port: number, fixture: FixtureIdentity) {
  await assertFixtureIdentity(dataDir, fixture);
  const pidFile = path.join(dataDir, "postmaster.pid");
  const info = await fs.promises.lstat(pidFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Embedded PostgreSQL test pid file is not an owned regular file.");
  const lines = (await fs.promises.readFile(pidFile, "utf8")).split(/\r?\n/);
  const pid = Number(lines[0]);
  const startedAt = Number(lines[2]);
  const recordedPort = Number(lines[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startedAt) || startedAt <= 0
    || typeof lines[1] !== "string" || normalizedPath(lines[1]) !== normalizedPath(fixture.canonicalPath)
    || recordedPort !== port) {
    throw new Error("Embedded PostgreSQL test ready pid file does not match this fixture.");
  }
  fixture.postmaster = { pid, startedAt };
}

function observeOwnedProcessClose(child: ChildProcess | undefined): { promise: Promise<void>; dispose(): void } {
  if (!child || childFullyClosed(child)) return { promise: Promise.resolve(), dispose() {} };
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
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
  return { promise, dispose: () => cleanup() };
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
  dependencies: { resolvePgCtl?: () => Promise<string>; spawnPgCtl?: typeof spawn } = {},
) {
  const child = (instance as unknown as { process?: ChildProcess }).process;
  const childClose = observeOwnedProcessClose(child);
  try {
    const owned = await readOwnedPostmasterPidFile(dataDir, port, fixture);
    if (owned) {
      const pgCtl = await (dependencies.resolvePgCtl ?? resolvePgCtlPath)();
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        const process = (dependencies.spawnPgCtl ?? spawn)(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "-t", "20", "stop"], {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        const onStderr = (chunk: Buffer | string) => {
          stderr = `${stderr}${String(chunk)}`.slice(-4096);
        };
        process.stderr?.on("data", onStderr);
        const cleanup = () => {
          clearTimeout(timer);
          process.stderr?.removeListener("data", onStderr);
          process.removeListener("error", onError);
          process.removeListener("close", onClose);
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = (code: number | null) => {
          cleanup();
          if (code === 0) resolve();
          else reject(new Error(`Embedded PostgreSQL test pg_ctl shutdown failed with exit code ${code} (category: ${classifyPgCtlFailure(stderr)}).`));
        };
        const timer = setTimeout(() => {
          cleanup();
          try { process.kill(); } catch { /* This is only the pg_ctl child created above. */ }
          reject(new Error("Embedded PostgreSQL test pg_ctl shutdown timed out; preserving fixture data."));
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

function formatEmbeddedPostgresError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "embedded Postgres startup failed";
}

export function classifyPgCtlFailure(output: string): "access_denied" | "pid_file" | "server_unavailable" | "signal_failure" | "other" {
  const message = output.toLowerCase();
  if (/access is denied|permission denied|operation not permitted/.test(message)) return "access_denied";
  if (/postmaster\.pid|pid file|lock file/.test(message)) return "pid_file";
  if (/no server running|could not connect|connection refused/.test(message)) return "server_unavailable";
  if (/could not send.*signal|failed to send.*signal|kill\(\).*failed/.test(message)) return "signal_failure";
  return "other";
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let dataDir: string | null = null;
  let dataDirIdentity: FixtureIdentity | null = null;
  let port: number | null = null;
  let instance: EmbeddedPostgresInstance | null = null;
  let startupError: unknown;

  try {
    const created = await createEmbeddedPostgresTestInstance(
      "paperclip-embedded-postgres-probe-",
    );
    dataDir = created.dataDir;
    dataDirIdentity = created.dataDirIdentity;
    port = created.port;
    instance = created.instance;
    await instance.initialise();
    await instance.start();
    await captureOwnedPostmasterIdentity(dataDir, port, dataDirIdentity);
  } catch (error) {
    startupError = error;
  }
  try {
    if (dataDir && dataDirIdentity && port !== null && instance) {
      await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity);
      await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
    }
  } catch (cleanupError) {
    if (startupError) throw new AggregateError([startupError, cleanupError], "Embedded PostgreSQL support probe and cleanup failed.");
    throw cleanupError;
  }
  return startupError
    ? { supported: false, reason: formatEmbeddedPostgresError(startupError) }
    : { supported: true };
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

  try {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    dataDir = created.dataDir;
    dataDirIdentity = created.dataDirIdentity;
    instance = created.instance;
    port = created.port;
    await instance.initialise();
    await instance.start();
    await captureOwnedPostmasterIdentity(dataDir, port, dataDirIdentity);

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        if (!dataDir || !dataDirIdentity || port === null || !instance) throw new Error("Embedded PostgreSQL test fixture ownership is unavailable.");
        await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity);
        await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
      },
    };
  } catch (error) {
    try {
      if (dataDir && dataDirIdentity && port !== null && instance) {
        await stopEmbeddedPostgresTestInstance(dataDir, port, instance, dataDirIdentity);
        await cleanupEmbeddedPostgresTestDirs(dataDir, dataDirIdentity);
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Failed to start embedded PostgreSQL test database; fixture cleanup also failed.");
    }
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${formatEmbeddedPostgresError(error)}`,
    );
  }
}
