import { describe, expect, it } from "vitest";
import {
  buildSpsDesktopJoinUri,
  buildSpsInviteUrl,
  inviteTokenToSpsCode,
  spsCodeToInviteToken,
} from "./sps-invite-code";

describe("SPS invite codes", () => {
  it("formats both legacy and SPS-prefixed invite tokens as a readable SPS code", () => {
    expect(inviteTokenToSpsCode("pcp_invite_ab12cd34")).toBe("SPS-AB12-CD34");
    expect(inviteTokenToSpsCode("sps_invite_ab12cd34")).toBe("SPS-AB12-CD34");
  });

  it("normalizes a pasted SPS code into the current invite token", () => {
    expect(spsCodeToInviteToken(" sps-ab12 cd34 ")).toBe("sps_invite_ab12cd34");
    expect(spsCodeToInviteToken("not a code")).toBeNull();
  });

  it("builds a desktop deep link and a safe invite URL", () => {
    expect(buildSpsDesktopJoinUri("https://hub.example/invite/sps_invite_ab12cd34", "sps_invite_ab12cd34"))
      .toBe("sps://join?hub=https%3A%2F%2Fhub.example&code=SPS-AB12-CD34");
    expect(buildSpsInviteUrl("hub.example:3100", "sps_invite_ab12cd34"))
      .toBe("http://hub.example:3100/invite/sps_invite_ab12cd34");
    expect(buildSpsInviteUrl("file:///not-a-hub", "sps_invite_ab12cd34")).toBeNull();
  });
});
