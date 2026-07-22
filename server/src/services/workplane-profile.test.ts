import { describe, expect, it } from "vitest";
import { getWorkplaneRuntimeProfile } from "./workplane-profile.js";

describe("getWorkplaneRuntimeProfile", () => {
  it("keeps Core neutral while exposing an explicit Workplane profile", () => {
    expect(getWorkplaneRuntimeProfile({
      SPS_WORKPLANE_MODE: "true",
      SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES: "plugin:example.rooms:agent-room, plugin:example.rooms:provisioning",
      SPS_WORKPLANE_DEFAULT_PROJECT_TAB: "plugin:example.rooms:project-workplane",
    })).toEqual({
      enabled: true,
      roomOriginPrefixes: [
        "plugin:example.rooms:agent-room",
        "plugin:example.rooms:provisioning",
      ],
      defaultProjectTab: "plugin:example.rooms:project-workplane",
    });
  });

  it("rejects SQL wildcard prefixes and unsafe default tabs", () => {
    expect(getWorkplaneRuntimeProfile({
      SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES: "plugin:ok:room%, plugin:also-ok:room",
      SPS_WORKPLANE_DEFAULT_PROJECT_TAB: "plugin:bad tab",
    })).toEqual({
      enabled: false,
      roomOriginPrefixes: ["plugin:also-ok:room"],
      defaultProjectTab: null,
    });
  });
});
