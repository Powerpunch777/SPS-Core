import { describe, expect, it } from "vitest";
import { hasSpsNodeClosureEvidence } from "./sps-node-closure-evidence.js";

const now = new Date();
const policyFailed = { status: "failed", claimedAt: now, startedAt: now, finishedAt: now, exitCode: null, signal: null, timedOut: 0 };

describe("Node closure evidence", () => {
  it("keeps policy failures and malformed receipts unconfirmed even with finishedAt", () => {
    expect(hasSpsNodeClosureEvidence(policyFailed)).toBe(false);
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, claimedAt: null })).toBe(false);
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, completionReceiptDigest: "invalid" })).toBe(false);
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, finishedAt: null, completionReceiptDigest: "a".repeat(64) })).toBe(false);
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, status: "running", completionReceiptDigest: "a".repeat(64) }, true)).toBe(false);
  });

  it("accepts signed receipt and legacy completion-only markers without adopting a PID", () => {
    expect(hasSpsNodeClosureEvidence(policyFailed, true)).toBe(true);
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, completionReceiptDigest: "a".repeat(64) })).toBe(true);
    for (const marker of [{ status: "succeeded" }, { exitCode: 0 }, { signal: "SIGTERM" }, { timedOut: 1 }]) {
      expect(hasSpsNodeClosureEvidence({ ...policyFailed, ...marker })).toBe(true);
    }
    expect(hasSpsNodeClosureEvidence({ ...policyFailed, claimedAt: null, startedAt: null })).toBe(true);
  });
});
