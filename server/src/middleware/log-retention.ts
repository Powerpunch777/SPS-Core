import fs from "node:fs";

export const DEFAULT_SERVER_LOG_MAX_BYTES = 20 * 1024 * 1024;

export function resolveServerLogMaxBytes(rawValue: string | undefined): number {
  if (!rawValue?.trim()) return DEFAULT_SERVER_LOG_MAX_BYTES;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 1024
    ? parsed
    : DEFAULT_SERVER_LOG_MAX_BYTES;
}

export function rotateServerLogIfOversize(logFile: string, maxBytes: number): {
  rotated: boolean;
  previousBytes: number;
  retainedBytes: number;
} {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  if (!fs.existsSync(logFile)) {
    return { rotated: false, previousBytes: 0, retainedBytes: 0 };
  }

  const previousBytes = fs.statSync(logFile).size;
  if (previousBytes <= maxBytes) {
    return { rotated: false, previousBytes, retainedBytes: previousBytes };
  }

  const retainedLength = Math.min(maxBytes, previousBytes);
  const retained = Buffer.allocUnsafe(retainedLength);
  const descriptor = fs.openSync(logFile, "r");
  try {
    fs.readSync(descriptor, retained, 0, retainedLength, previousBytes - retainedLength);
  } finally {
    fs.closeSync(descriptor);
  }

  // Drop the first partial log line when the retained tail starts mid-record.
  const firstNewline = retained.indexOf(0x0a);
  const completeLines = firstNewline >= 0 ? retained.subarray(firstNewline + 1) : retained;
  fs.writeFileSync(`${logFile}.1`, completeLines, { mode: 0o600 });
  fs.truncateSync(logFile, 0);

  return {
    rotated: true,
    previousBytes,
    retainedBytes: completeLines.length,
  };
}
