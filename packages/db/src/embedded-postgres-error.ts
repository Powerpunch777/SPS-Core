const DEFAULT_RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(fallbackMessage);
  if (typeof error === "string") return new Error(`${fallbackMessage}: ${error}`);

  try {
    return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join("\n").toLowerCase();
  if (haystack.includes("could not create shared memory segment")) {
    return (
      "Embedded PostgreSQL bootstrap could not allocate shared memory. " +
      "On macOS, this usually means the host's kern.sysv.shm* limits are too low for another local PostgreSQL cluster. " +
      "Stop other local PostgreSQL servers or raise the shared-memory sysctls, then retry."
    );
  }

  if (/\b(eperm|eacces)\b|permission denied|access is denied|operation not permitted/.test(haystack)) {
    return (
      "Embedded PostgreSQL could not access or execute one of its local files. " +
      "On Windows, check Controlled Folder Access or antivirus history, then make sure the SPS data directory is writable and retry."
    );
  }

  if (/\b(enoent|not found)\b|no such file|cannot find the file|missing executable/.test(haystack)) {
    return (
      "Embedded PostgreSQL could not find a required local executable or data file. " +
      "Repair the SPS installation or reinstall its local database runtime, then retry."
    );
  }

  if (/address already in use|eaddrinuse|could not bind|bind\(\) failed/.test(haystack)) {
    return (
      "Embedded PostgreSQL could not reserve a local port. " +
      "Close another local PostgreSQL process or retry after the conflicting process exits."
    );
  }

  return null;
}

export function createEmbeddedPostgresLogBuffer(limit = DEFAULT_RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? "");

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: {
    fallbackMessage: string;
    recentLogs?: string[];
  },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const recentLogs = input.recentLogs ?? [];
  const parts = [baseError.message];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);

  if (hint) {
    parts.push(hint);
  }
  if (recentSummary) {
    parts.push(`Recent embedded Postgres logs: ${recentSummary}`);
  }

  return new Error(parts.join(" "));
}
