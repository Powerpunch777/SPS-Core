import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inviteTokenHashCandidates } from "../routes/access.js";

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

describe("SPS invite token compatibility", () => {
  it("resolves a current SPS code token against both current and legacy stored invites", () => {
    expect(inviteTokenHashCandidates("sps_invite_ab12cd34")).toEqual([
      hash("sps_invite_ab12cd34"),
      hash("pcp_invite_ab12cd34"),
    ]);
  });

  it("keeps a direct legacy invite link valid after the SPS token migration", () => {
    expect(inviteTokenHashCandidates("pcp_invite_ab12cd34")).toEqual([
      hash("pcp_invite_ab12cd34"),
      hash("sps_invite_ab12cd34"),
    ]);
  });

  it("keeps a current long SPS invite compatible with the previous prefix", () => {
    expect(inviteTokenHashCandidates("sps_invite_ab12cd34ef56gh78")).toEqual([
      hash("sps_invite_ab12cd34ef56gh78"),
      hash("pcp_invite_ab12cd34ef56gh78"),
    ]);
  });

  it("does not broaden lookup for malformed tokens", () => {
    expect(inviteTokenHashCandidates("sps_invite_not-a-token")).toEqual([
      hash("sps_invite_not-a-token"),
    ]);
  });
});
