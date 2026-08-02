import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWindowsSubstMappings,
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
  resolveWindowsNativeRuntimePath,
  resolveWindowsShortPath,
} from "./embedded-postgres-native.js";

describe("embedded Postgres native runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("creates soname aliases for bundled patch-level shared libraries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "libicui18n.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "README.md"), "");

    const created = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(created.map((file) => path.basename(file)).sort()).toEqual([
      "libicui18n.so.60",
      "libicuuc.so.60",
    ]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });

  it.runIf(process.platform !== "win32")("is idempotent when aliases already exist", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");

    await ensureLinuxSharedLibraryAliases(tempDir);
    const second = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(second).toEqual([]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });

  it("does not invoke the Windows short-path bridge for an ASCII path", () => {
    expect(resolveWindowsShortPath("C:\\SPS\\runtime\\bin")).toBeNull();
    expect(resolveWindowsNativeRuntimePath("C:\\SPS\\runtime\\bin")).toBeNull();
  });

  it.runIf(process.platform === "win32")("replaces an inherited native binary path with a locally derived ASCII path", async () => {
    const previous = process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR;
    process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR = "C:\\untrusted\\postgres-bin";
    try {
      await prepareEmbeddedPostgresNativeRuntime();
      const derived = process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR;
      expect(derived).not.toBe("C:\\untrusted\\postgres-bin");
      if (derived) {
        expect(path.isAbsolute(derived)).toBe(true);
        expect(derived).toMatch(/^[\x00-\x7f]+$/);
      }
    } finally {
      cleanupWindowsSubstMappings();
      if (previous === undefined) delete process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR;
      else process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR = previous;
    }
  });
});
