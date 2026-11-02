type NodeExecution = Readonly<{
  status: string;
  claimedAt?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  completionReceiptDigest?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: number;
}>;

/** Policy failure/finishedAt alone is not a remote-process closure report. */
export function hasSpsNodeClosureEvidence(row: NodeExecution, parentReceipt = false): boolean {
  if (!["succeeded", "failed", "cancelled"].includes(row.status) || row.finishedAt == null) return false;
  if (row.claimedAt == null && row.startedAt == null) return true;
  // These legacy result markers were written only by signed Node completions.
  return parentReceipt
    || typeof row.completionReceiptDigest === "string" && /^[0-9a-f]{64}$/.test(row.completionReceiptDigest)
    || row.status === "succeeded"
    || row.exitCode != null
    || row.signal != null
    || row.timedOut === 1;
}
