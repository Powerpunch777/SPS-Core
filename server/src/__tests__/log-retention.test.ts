import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_LOG_MAX_BYTES,
  resolveServerLogMaxBytes,
  rotateServerLogIfOversize,
} from "../middleware/log-retention.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryLogFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sps-log-retention-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "server.log");
}

describe("server log retention", () => {
  it("uses a bounded default for missing or invalid configuration", () => {
    expect(resolveServerLogMaxBytes(undefined)).toBe(DEFAULT_SERVER_LOG_MAX_BYTES);
    expect(resolveServerLogMaxBytes("invalid")).toBe(DEFAULT_SERVER_LOG_MAX_BYTES);
    expect(resolveServerLogMaxBytes("512")).toBe(DEFAULT_SERVER_LOG_MAX_BYTES);
    expect(resolveServerLogMaxBytes("4096")).toBe(4096);
  });

  it("keeps a small active log unchanged", () => {
    const logFile = temporaryLogFile();
    fs.writeFileSync(logFile, "one\ntwo\n");

    expect(rotateServerLogIfOversize(logFile, 32)).toEqual({
      rotated: false,
      previousBytes: 8,
      retainedBytes: 8,
    });
    expect(fs.readFileSync(logFile, "utf8")).toBe("one\ntwo\n");
    expect(fs.existsSync(`${logFile}.1`)).toBe(false);
  });

  it("retains only complete recent lines and clears the active log", () => {
    const logFile = temporaryLogFile();
    fs.writeFileSync(logFile, "oldest-record\nmiddle-record\nlatest-record\n");

    const result = rotateServerLogIfOversize(logFile, 30);

    expect(result.rotated).toBe(true);
    expect(result.retainedBytes).toBeLessThanOrEqual(30);
    expect(fs.readFileSync(logFile, "utf8")).toBe("");
    const retained = fs.readFileSync(`${logFile}.1`, "utf8");
    expect(retained).toBe("middle-record\nlatest-record\n");
    expect(retained).not.toContain("oldest-record");
  });
});
