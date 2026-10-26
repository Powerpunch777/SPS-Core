import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type FsStub = {
  stat(path: string): Promise<{ mode: number }>;
  chmod(path: string, mode: number): Promise<void>;
};
type EnsureBinIsExecutable = (path: string) => Promise<void>;
type GeneratorLike = {
  next(value?: unknown): IteratorResult<unknown, unknown>;
  throw(error?: unknown): IteratorResult<unknown, unknown>;
};

const resolvedLibrary = createRequire(import.meta.url).resolve("embedded-postgres");
const installedLibrarySource = readFileSync(resolvedLibrary, "utf8");

function runInstalledEnsureBinIsExecutable(fs: FsStub, osPlatform: string): EnsureBinIsExecutable {
  const start = installedLibrarySource.indexOf("const ensureBinIsExecutable =");
  const end = installedLibrarySource.indexOf("\n/**\n * This will track instances", start);
  if (start < 0 || end < 0) throw new Error("Could not extract the installed embedded-postgres executable guard.");
  const declaration = installedLibrarySource.slice(start, end).trim();

  function awaiter(
    _this: unknown,
    _args: unknown,
    promiseConstructor: PromiseConstructor | undefined,
    generator: () => Generator<unknown, unknown, unknown>,
  ): Promise<unknown> {
    const PromiseImpl = promiseConstructor ?? Promise;
    return new PromiseImpl((resolve, reject) => {
      const iterator = generator() as GeneratorLike;
      const step = (method: "next" | "throw", value?: unknown) => {
        let result: IteratorResult<unknown, unknown>;
        try {
          result = iterator[method](value);
        } catch (error) {
          reject(error);
          return;
        }
        if (result.done) {
          resolve(result.value);
          return;
        }
        PromiseImpl.resolve(result.value).then(
          next => step("next", next),
          error => step("throw", error),
        );
      };
      step("next");
    });
  }

  return runInNewContext(`${declaration}\nensureBinIsExecutable`, {
    BIN_PERMISSIONS: 0b101101101,
    fs,
    platform: () => osPlatform,
    __awaiter: awaiter,
  }) as EnsureBinIsExecutable;
}

describe("installed embedded-postgres executable mode guard", () => {
  it("does not stat or chmod on Windows", async () => {
    const fs = {
      stat: vi.fn(async () => ({ mode: 0o666 })),
      chmod: vi.fn(async () => {}),
    };

    await runInstalledEnsureBinIsExecutable(fs, "win32")("postgres.exe");

    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it("adds missing executable bits on Linux", async () => {
    const fs = {
      stat: vi.fn(async () => ({ mode: 0o644 })),
      chmod: vi.fn(async () => {}),
    };

    await runInstalledEnsureBinIsExecutable(fs, "linux")("postgres");

    expect(fs.stat).toHaveBeenCalledExactlyOnceWith("postgres");
    expect(fs.chmod).toHaveBeenCalledExactlyOnceWith("postgres", 0o755);
  });

  it("does not chmod an already executable binary", async () => {
    const fs = {
      stat: vi.fn(async () => ({ mode: 0o755 })),
      chmod: vi.fn(async () => {}),
    };

    await runInstalledEnsureBinIsExecutable(fs, "darwin")("postgres");

    expect(fs.stat).toHaveBeenCalledExactlyOnceWith("postgres");
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it("propagates stat and chmod errors on POSIX", async () => {
    const statError = new Error("stat failed");
    const statFs = {
      stat: vi.fn(async () => { throw statError; }),
      chmod: vi.fn(async () => {}),
    };
    await expect(runInstalledEnsureBinIsExecutable(statFs, "linux")("postgres")).rejects.toBe(statError);
    expect(statFs.chmod).not.toHaveBeenCalled();

    const chmodError = new Error("chmod failed");
    const chmodFs = {
      stat: vi.fn(async () => ({ mode: 0o644 })),
      chmod: vi.fn(async () => { throw chmodError; }),
    };
    await expect(runInstalledEnsureBinIsExecutable(chmodFs, "linux")("postgres")).rejects.toBe(chmodError);
  });

  it("awaits executable checks before either initializer or server spawn", () => {
    const initialiseStart = installedLibrarySource.indexOf("    initialise() {");
    const startStart = installedLibrarySource.indexOf("    start() {", initialiseStart);
    const stopStart = installedLibrarySource.indexOf("    stop() {", startStart);
    if (initialiseStart < 0 || startStart < 0 || stopStart < 0) {
      throw new Error("Could not extract installed embedded-postgres lifecycle methods.");
    }
    const initialiseSource = installedLibrarySource.slice(initialiseStart, startStart);
    const startSource = installedLibrarySource.slice(startStart, stopStart);
    const ensurePostgres = initialiseSource.indexOf("yield ensureBinIsExecutable(postgres);");
    const ensureInitdb = initialiseSource.indexOf("yield ensureBinIsExecutable(initdb);");
    const initdbSpawn = initialiseSource.indexOf("spawn(initdb,");
    const ensureServer = startSource.indexOf("yield ensureBinIsExecutable(postgres);");
    const postgresSpawn = startSource.indexOf("spawn(postgres,");

    expect(ensurePostgres).toBeGreaterThanOrEqual(0);
    expect(ensureInitdb).toBeGreaterThan(ensurePostgres);
    expect(initdbSpawn).toBeGreaterThan(ensureInitdb);
    expect(ensureServer).toBeGreaterThanOrEqual(0);
    expect(postgresSpawn).toBeGreaterThan(ensureServer);
  });
});
