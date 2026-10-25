import { describe, expect, it } from "vitest";
import { describeSpsRuntimeConnection, isSpsNodeHeartbeatRecent } from "../services/sps-runtime-connection.js";

const now = Date.parse("2026-10-25T03:00:00.000Z");
const node = { status: "active", keyVerifiedAt: new Date(now - 1_000), lastSeenAt: new Date(now - 500) };

describe("SPS cached Node runtime connection", () => {
  it("keeps the execution owner and grant requirement separate from a recent heartbeat", () => {
    expect(describeSpsRuntimeConnection(node, now)).toEqual({
      executionOwner: "node", authorization: "execution_grant_required", state: "recently_seen",
      observedAt: node.lastSeenAt.toISOString(),
    });
    expect(describeSpsRuntimeConnection({ ...node, lastSeenAt: new Date(now - 120_000) }, now).state).toBe("recently_seen");
    expect(describeSpsRuntimeConnection({ ...node, lastSeenAt: new Date(now - 120_001) }, now).state).toBe("offline");
  });

  it("does not treat unapproved or inactive Nodes as online even with a fresh heartbeat", () => {
    expect(describeSpsRuntimeConnection({ ...node, keyVerifiedAt: null }, now).state).toBe("unverified");
    expect(describeSpsRuntimeConnection({ ...node, keyVerifiedAt: new Date(NaN) }, now).state).toBe("unverified");
    for (const status of ["pending", "revoked", "disabled", "unexpected"]) {
      expect(describeSpsRuntimeConnection({ ...node, status }, now).state).toBe("inactive");
    }
  });

  it("keeps missing, invalid or future heartbeat evidence unknown rather than online", () => {
    for (const lastSeenAt of [null, new Date(NaN), new Date(now + 1)]) {
      expect(describeSpsRuntimeConnection({ ...node, lastSeenAt }, now)).toMatchObject({ state: "unknown", observedAt: null });
      expect(isSpsNodeHeartbeatRecent(lastSeenAt, now)).toBe(false);
    }
    expect(isSpsNodeHeartbeatRecent(node.lastSeenAt, NaN)).toBe(false);
    expect(isSpsNodeHeartbeatRecent(node.lastSeenAt, Infinity)).toBe(false);
  });

  it("projects only fixed, non-sensitive technical fields", () => {
    const result = describeSpsRuntimeConnection({ ...node, token: "private", home: "C:/private", endpoint: "https://private.example" } as typeof node, now);
    expect(Object.keys(result).sort()).toEqual(["authorization", "executionOwner", "observedAt", "state"]);
    expect(JSON.stringify(result)).not.toMatch(/private|https?:|C:\//);
  });
});
