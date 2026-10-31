import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSpsNodeClaimRequestId, SPS_NODE_CLAIM_MAX_AGE_MS } from "./sps-node-claim-receipt.js";

const now = Date.parse("2026-10-29T04:00:00.000Z");
const idAt = (time: number) => `v1:${time}:${randomUUID()}`;

describe("SPS Node claim receipt lifetime", () => {
  it("keeps one fixed expiry across retries instead of extending it", () => {
    const id = idAt(now);
    expect(parseSpsNodeClaimRequestId(id, now)).toEqual({ requestId: id, expiresAt: new Date(now + SPS_NODE_CLAIM_MAX_AGE_MS) });
    expect(parseSpsNodeClaimRequestId(id, now + 60_000)).toEqual(parseSpsNodeClaimRequestId(id, now));
  });

  it("rejects expired request ids even when their receipt has already been pruned", () => {
    const id = idAt(now - SPS_NODE_CLAIM_MAX_AGE_MS);
    expect(() => parseSpsNodeClaimRequestId(id, now)).toThrow(expect.objectContaining({
      status: 409, details: { code: "sps_node_claim_expired" },
    }));
  });

  it("rejects malformed or far-future ids without treating them as fresh requests", () => {
    for (const id of [null, randomUUID(), `v1:0:${randomUUID()}`, idAt(now + 300_001), "v2:" + now + ":" + randomUUID()]) {
      expect(() => parseSpsNodeClaimRequestId(id, now)).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});
