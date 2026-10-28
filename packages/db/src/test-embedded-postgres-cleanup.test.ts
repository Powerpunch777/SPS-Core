import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { classifyEmbeddedPostgresFailure, createEmbeddedPostgresShutdownPhaseObserver, createEmbeddedPostgresStartupSqlStateObserver,
  embeddedPostgresStartupTermination, embeddedPostgresSupportResult, formatEmbeddedPostgresTestSupportFailure, classifyPgCtlFailure, stopEmbeddedPostgresTestInstance,
  type EmbeddedPostgresInstance, type FixtureIdentity } from "./test-embedded-postgres.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makePostgresChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & Pick<ChildProcess, "pid" | "connected" | "exitCode" | "signalCode" | "stdio">;
  Object.assign(child, { pid, connected: true, exitCode: null, signalCode: null, stdio: [] });
  return child;
}

function fixture() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "embedded-postgres-cleanup-test-"));
  tempDirs.push(dataDir);
  const root = lstatSync(dataDir, { bigint: true });
  const dataDirIdentity: FixtureIdentity = { canonicalPath: realpathSync(dataDir), dev: root.dev, ino: root.ino, birthtimeNs: root.birthtimeNs };
  const pid = 43210;
  const port = 54389;
  const startedAt = 1_798_000_000;
  const pidFile = path.join(dataDir, "postmaster.pid");
  writeFileSync(pidFile, `${pid}\n${dataDir}\n${startedAt}\n${port}\n127.0.0.1\n\n\n\n\n\n\n\n\n`, "utf8");
  const child = makePostgresChild(pid);
  const stop = vi.fn(async () => {});
  const instance = { initialise: vi.fn(), start: vi.fn(), stop, process: child } as unknown as EmbeddedPostgresInstance;
  dataDirIdentity.postmaster = { pid, startedAt };
  return { dataDir, dataDirIdentity, pid, port, pidFile, child, instance };
}

describe("embedded Postgres test cleanup", () => {
  it.each([
    ["could not send stop signal: Access is denied", "access_denied"],
    ["could not open postmaster.pid", "pid_file"],
    ["no server running", "server_unavailable"],
    ["could not send signal to process", "signal_failure"],
    ["waiting for server to shut down.... failed\npg_ctl: server does not shut down", "shutdown_timeout"],
    ["timed out waiting for server to shut down", "shutdown_timeout"],
    ["unexpected detail with a private path", "other"],
  ] as const)("classifies pg_ctl diagnostics without retaining raw output", (output, expected) => {
    expect(classifyPgCtlFailure(output)).toBe(expected);
  });

  it.each([
    [undefined, null, "postgres_start", "process_exited_before_ready"],
    ["Postgres init script exited with code 1. Please check the logs for extra info.", null, "initdb", "initdb_failed"],
    [new Error("private path denied: access is denied"), null, "postgres_start", "permission_denied"],
    [Object.assign(new Error("startup failed"), { code: "EADDRINUSE" }), null, "postgres_start", "port_in_use"],
    [new Error("startup failed"), "binary_unavailable", "postgres_start", "binary_unavailable"],
    [new Error("private token and path"), null, "migrations", "other"],
  ] as const)("classifies startup failures without retaining private diagnostics", (error, logCategory, stage, expected) => {
    expect(classifyEmbeddedPostgresFailure(error, logCategory, stage)).toBe(expected);
  });

  it.each([
    [{ kind: "exit", code: 0 }, "process_exited_before_ready"],
    [{ kind: "exit", code: 1 }, "process_exited_before_ready"],
    [{ kind: "exit", code: 0xc0000135 }, "binary_unavailable"],
    [{ kind: "exit", code: -0x3ffffecb }, "binary_unavailable"],
    [{ kind: "exit", code: 0xc0000139 }, "binary_unavailable"],
    [{ kind: "exit", code: 0xc000007b }, "binary_unavailable"],
    [{ kind: "signal" }, "process_signaled_before_ready"],
  ] as const)("classifies fixed postgres child termination metadata", (termination, expected) => {
    expect(classifyEmbeddedPostgresFailure(undefined, null, "postgres_start", termination)).toBe(expected);
  });

  it("snapshots only bounded exit metadata and never copies arbitrary child strings", () => {
    expect(embeddedPostgresStartupTermination({ exitCode: 1, signalCode: null } as never)).toEqual({ kind: "exit", code: 1 });
    expect(embeddedPostgresStartupTermination({ exitCode: null, signalCode: "SIGTERM", error: "private path" } as never)).toEqual({ kind: "signal" });
    expect(embeddedPostgresStartupTermination({ exitCode: 0x1_0000_0000, signalCode: null } as never)).toBeUndefined();
    expect(embeddedPostgresStartupTermination({ exitCode: null, signalCode: null, error: "private path" } as never)).toBeUndefined();
    expect(embeddedPostgresSupportResult(true, undefined, null, "postgres_start", { kind: "signal" })).toEqual({
      supported: false,
      reason: "embedded Postgres postgres_start failed (process_signaled_before_ready)",
      startupTermination: { kind: "signal" },
    });
  });

  it("recognizes fixed PostgreSQL shutdown phases across split log chunks without exposing the log", () => {
    const observer = createEmbeddedPostgresShutdownPhaseObserver();
    observer.observe("checkpoint complete: ordinary checkpoint before shutdown");
    expect(observer.phase()).toBe("none");
    observer.observe("received fast shutdown req");
    observer.observe("uest\naborting any active transactions\ncheckpoint starting: shu");
    expect(observer.phase()).toBe("transactions_aborting");
    observer.observe("tdown");
    expect(observer.phase()).toBe("shutdown_checkpoint_starting");
    observer.observe("tdown\ncheckpoint complete\ndatabase system is shut down\nprivate-path private-token");
    expect(observer.phase()).toBe("database_shutdown_complete");
    expect(Object.keys(observer)).toEqual(["observe", "phase"]);
  });

  it("keeps a valueless vendor start rejection unsupported with a safe phase and category", () => {
    expect(embeddedPostgresSupportResult(true, undefined, null, "postgres_start")).toEqual({
      supported: false,
      reason: "embedded Postgres postgres_start failed (process_exited_before_ready)",
    });
    expect(embeddedPostgresSupportResult(false, undefined, null, "postgres_start")).toEqual({ supported: true });
    for (const error of [undefined, null, "", 0, false]) {
      expect(embeddedPostgresSupportResult(true, error, null, "postgres_start")).toMatchObject({ supported: false });
    }
  });

  it("recognizes only allowlisted verbose startup SQLSTATEs across split chunks", () => {
    const observer = createEmbeddedPostgresStartupSqlStateObserver();
    observer.observe("2026-10-28 03:00:00 UTC [123] FATAL:  28P");
    observer.observe("01: password authentication failed for user private-user\n");
    expect(observer.sqlState()).toBe("28P01");
    expect(observer.bufferedLength()).toBeLessThanOrEqual(512);
    expect(Object.keys(observer)).toEqual(["observe", "reset", "sqlState", "bufferedLength"]);

    observer.reset();
    observer.observe("2026-10-28 03:00:00 UTC [123] PANIC:  57P03: server starting\n");
    expect(observer.sqlState()).toBe("57P03");
    observer.reset();
    expect(observer.sqlState()).toBeUndefined();
  });

  it("bounds SQLSTATE carry and ignores unknown or malformed startup records", () => {
    const observer = createEmbeddedPostgresStartupSqlStateObserver();
    observer.observe(`${"private-log-fragment".repeat(1000)}\n2026-10-28 FATAL:  57014: private query`);
    expect(observer.bufferedLength()).toBeLessThanOrEqual(512);
    expect(observer.sqlState()).toBeUndefined();
    observer.observe("\n2026-10-28 LOG:  28P01: not an error severity\n2026-10-28 FATAL: xx001: malformed\n");
    expect(observer.sqlState()).toBeUndefined();
  });

  it("formats only fixed startup category, bounded exit metadata, and allowlisted startup SQLSTATE", () => {
    const support = embeddedPostgresSupportResult(true, undefined, null, "postgres_start", { kind: "exit", code: 1 }, "28P01");
    expect(support).toEqual({
      supported: false,
      reason: "embedded Postgres postgres_start failed (process_exited_before_ready)",
      startupTermination: { kind: "exit", code: 1 },
      startupSqlState: "28P01",
    });
    expect(formatEmbeddedPostgresTestSupportFailure(support))
      .toBe("embedded Postgres postgres_start failed (process_exited_before_ready); child_exit=1; sqlstate=28P01");
    expect(formatEmbeddedPostgresTestSupportFailure({
      supported: false,
      reason: "embedded Postgres migrations failed (other)",
      startupTermination: { kind: "exit", code: 1 },
      startupSqlState: "28P01",
    })).toBe("embedded Postgres migrations failed (other)");
    expect(formatEmbeddedPostgresTestSupportFailure({
      supported: false,
      reason: "private path private token",
      startupSqlState: "28P01",
    })).toBe("embedded Postgres support probe unavailable");
    expect(formatEmbeddedPostgresTestSupportFailure({
      supported: false,
      reason: "embedded Postgres postgres_start failed (process_exited_before_ready)",
      startupSqlState: "private-secret" as never,
    })).toBe("embedded Postgres postgres_start failed (process_exited_before_ready)");
    expect(formatEmbeddedPostgresTestSupportFailure(embeddedPostgresSupportResult(false, undefined, null, "postgres_start")))
      .toBe("embedded Postgres test support is available");
    expect(formatEmbeddedPostgresTestSupportFailure({
      supported: true,
      reason: "embedded Postgres postgres_start failed (other)",
      startupTermination: { kind: "exit", code: 1 },
      startupSqlState: "28P01",
    })).toBe("embedded Postgres test support is available");
  });

  it("uses pg_ctl for the exact owned pid-file and waits for child close before clearing its hook handle", async () => {
    const value = fixture();
    const stdout = { destroyed: false };
    const stderr = { destroyed: false };
    Object.assign(value.child, { exitCode: 0, stdio: [null, stdout, stderr] });
    const pgCtlChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const spawnPgCtl = vi.fn((command: string, args: readonly string[]) => {
      expect(command).toBe("pg_ctl-fixture");
      expect(args).toEqual(["-D", value.dataDir, "-m", "fast", "-w", "-t", "20", "stop"]);
      setImmediate(() => {
        rmSync(value.pidFile);
        pgCtlChild.emit("close", 0, null);
        setImmediate(() => {
          stdout.destroyed = true;
          stderr.destroyed = true;
          Object.assign(value.child, { connected: false, exitCode: 0 });
          value.child.emit("close", 0, null);
        });
      });
      return pgCtlChild as never;
    });

    await stopEmbeddedPostgresTestInstance(value.dataDir, value.port, value.instance, value.dataDirIdentity, {
      resolvePgCtl: async () => "pg_ctl-fixture",
      spawnPgCtl: spawnPgCtl as never,
    });

    expect(spawnPgCtl).toHaveBeenCalledTimes(1);
    expect(value.instance.stop).not.toHaveBeenCalled();
    expect(value.instance.process).toBeUndefined();
  });

  it("reports bounded pg_ctl diagnostics without raw output and preserves the owned fixture on failure", async () => {
    const value = fixture();
    Object.assign(value.child, { exitCode: 1 });
    const pgCtlChild = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const stdoutText = `${"private-hostname ".repeat(500)}could not connect to server`;
    const stderrText = `${"shutdown detail private-token ".repeat(500)}failure`;
    const spawnPgCtl = vi.fn(() => {
      setImmediate(() => {
        pgCtlChild.stdout.emit("data", stdoutText);
        pgCtlChild.stderr.emit("data", stderrText);
        pgCtlChild.emit("close", 1, null);
      });
      return pgCtlChild as never;
    });

    let failure: unknown;
    try {
      await stopEmbeddedPostgresTestInstance(value.dataDir, value.port, value.instance, value.dataDirIdentity, {
        resolvePgCtl: async () => "pg_ctl-fixture",
        spawnPgCtl: spawnPgCtl as never,
        shutdownPhase: () => "transactions_aborting",
      });
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("exitCode=1");
    expect(message).toContain("category=server_unavailable");
    expect(message).toContain(`stdoutBytes=${Buffer.byteLength(stdoutText)}`);
    expect(message).toContain(`stderrBytes=${Buffer.byteLength(stderrText)}`);
    expect(message).toContain("ownedPidFileState=present");
    expect(message).toContain("childTerminalPhase=not_observed");
    expect(message).toContain("postgresShutdownPhase=transactions_aborting");
    expect(message).toContain("postgresTermination=exit:1");
    expect(message).not.toContain("private-hostname");
    expect(message).not.toContain("private-token");
    expect(message).not.toContain("shutdown detail");
    expect(message).not.toContain(value.dataDir);
    expect(spawnPgCtl).toHaveBeenCalledTimes(1);
    expect(value.instance.process).toBe(value.child);
    expect(existsSync(value.pidFile)).toBe(true);
    expect(value.child.listenerCount("close")).toBe(0);
    expect(value.child.listenerCount("error")).toBe(0);
  });

  it("accepts a child that was already fully closed before cleanup", async () => {
    const value = fixture();
    rmSync(value.pidFile);
    Object.assign(value.child, { connected: false, exitCode: 0 });

    await stopEmbeddedPostgresTestInstance(value.dataDir, value.port, value.instance, value.dataDirIdentity, {
      resolvePgCtl: async () => "pg_ctl-fixture",
      spawnPgCtl: vi.fn(),
    });

    expect(value.instance.process).toBeUndefined();
    expect(value.child.listenerCount("close")).toBe(0);
  });

  it("preserves a pid file whose port does not match this fixture and never invokes pg_ctl", async () => {
    const value = fixture();
    const spawnPgCtl = vi.fn();
    writeFileSync(value.pidFile, `${value.pid}\n${value.dataDir}\n0\n${value.port + 1}\n`, "utf8");

    await expect(stopEmbeddedPostgresTestInstance(value.dataDir, value.port, value.instance, value.dataDirIdentity, {
      resolvePgCtl: async () => "pg_ctl-fixture",
      spawnPgCtl: spawnPgCtl as never,
    })).rejects.toThrow("does not match this fixture");

    expect(spawnPgCtl).not.toHaveBeenCalled();
    expect(value.instance.process).toBe(value.child);
    expect(value.child.listenerCount("close")).toBe(0);
    expect(value.child.listenerCount("error")).toBe(0);
  });

  it("preserves a rewritten postmaster PID even when its directory and port still match", async () => {
    const value = fixture();
    const spawnPgCtl = vi.fn();
    writeFileSync(value.pidFile, `${value.pid + 1}\n${value.dataDir}\n${value.dataDirIdentity.postmaster?.startedAt}\n${value.port}\n`, "utf8");

    await expect(stopEmbeddedPostgresTestInstance(value.dataDir, value.port, value.instance, value.dataDirIdentity, {
      resolvePgCtl: async () => "pg_ctl-fixture",
      spawnPgCtl: spawnPgCtl as never,
    })).rejects.toThrow("does not match this fixture");

    expect(spawnPgCtl).not.toHaveBeenCalled();
    expect(value.child.listenerCount("close")).toBe(0);
    expect(value.child.listenerCount("error")).toBe(0);
  });
});
