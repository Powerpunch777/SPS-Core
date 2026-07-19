import { describe, expect, it } from "vitest";
import {
  buildSpsDesktopJoinUri,
  buildSpsInviteUrl,
  inviteTokenToSpsCode,
  spsCodeToInviteToken,
} from "./sps-invite-code";

describe("SPS invite codes", () => {
  it("formats legacy and current SPS invite tokens as readable codes", () => {
    expect(inviteTokenToSpsCode("pcp_invite_ab12cd34")).toBe("SPS-AB12-CD34");
    expect(inviteTokenToSpsCode("sps_invite_ab12cd34")).toBe("SPS-AB12-CD34");
    expect(inviteTokenToSpsCode("sps_invite_ab12cd34ef56gh78")).toBe("SPS-AB12-CD34-EF56-GH78");
  });

  it("normalizes both legacy and current pasted SPS codes into invite tokens", () => {
    expect(spsCodeToInviteToken(" sps-ab12 cd34 ")).toBe("sps_invite_ab12cd34");
    expect(spsCodeToInviteToken("SPS-AB12 CD34 EF56 GH78")).toBe("sps_invite_ab12cd34ef56gh78");
    expect(spsCodeToInviteToken("not a code")).toBeNull();
  });

  it("builds a desktop deep link and a safe invite URL", () => {
    expect(buildSpsDesktopJoinUri("https://hub.example/invite/sps_invite_ab12cd34ef56gh78", "sps_invite_ab12cd34ef56gh78"))
      .toBe("sps://join?hub=https%3A%2F%2Fhub.example&code=SPS-AB12-CD34-EF56-GH78");
    expect(buildSpsInviteUrl("hub.example", "sps_invite_ab12cd34ef56gh78"))
      .toBe("https://hub.example/invite/sps_invite_ab12cd34ef56gh78");
    expect(buildSpsInviteUrl("http://127.0.0.1:3100", "sps_invite_ab12cd34ef56gh78"))
      .toBe("http://127.0.0.1:3100/invite/sps_invite_ab12cd34ef56gh78");
    expect(buildSpsInviteUrl("http://[::1]:3100", "sps_invite_ab12cd34ef56gh78"))
      .toBe("http://[::1]:3100/invite/sps_invite_ab12cd34ef56gh78");
    expect(buildSpsInviteUrl("http://hub.example", "sps_invite_ab12cd34ef56gh78")).toBeNull();
    expect(buildSpsInviteUrl("file:///not-a-hub", "sps_invite_ab12cd34")).toBeNull();
  });
});
