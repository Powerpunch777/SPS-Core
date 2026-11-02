import { createHash } from "node:crypto";

export type SpsNodeCompletionReport = Readonly<{
  status: "succeeded" | "failed";
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string | null;
  usageReport?: Readonly<Record<string, unknown>>;
}>;

/** Store only the parsed completion fields that participate in the v1 receipt. */
export function normalizeSpsNodeCompletionReport(input: SpsNodeCompletionReport): SpsNodeCompletionReport {
  return Object.freeze({
    status: input.status,
    exitCode: input.exitCode,
    signal: input.signal ?? null,
    timedOut: input.timedOut ?? false,
    error: input.error ?? null,
    ...(input.usageReport === undefined ? {} : { usageReport: Object.freeze({ ...input.usageReport }) }),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Completion receipt contains a non-JSON value.");
  return serialized;
}

/**
 * Stable digest for a Node's parsed terminal report. This records what the
 * Node reported, even when Core maps the command's stored status to cancelled.
 */
export function createSpsNodeCompletionReceiptDigest(input: Readonly<{
  kind: "agent-command" | "plugin-run";
  nodeId: string;
  commandId: string;
  completion: SpsNodeCompletionReport;
}>): string {
  const completion = normalizeSpsNodeCompletionReport(input.completion);
  const canonical = canonicalJson({
    version: 1,
    kind: input.kind,
    nodeId: input.nodeId,
    commandId: input.commandId,
    completion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
