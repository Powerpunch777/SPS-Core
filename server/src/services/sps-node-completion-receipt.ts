import { createHash } from "node:crypto";

type Completion = Readonly<{
  status: "succeeded" | "failed";
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string | null;
  usageReport?: Readonly<Record<string, unknown>>;
}>;

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
  completion: Completion;
}>): string {
  const completion = {
    status: input.completion.status,
    exitCode: input.completion.exitCode,
    signal: input.completion.signal ?? null,
    timedOut: input.completion.timedOut ?? false,
    error: input.completion.error ?? null,
    ...(input.completion.usageReport === undefined ? {} : { usageReport: input.completion.usageReport }),
  };
  const canonical = canonicalJson({
    version: 1,
    kind: input.kind,
    nodeId: input.nodeId,
    commandId: input.commandId,
    completion,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
