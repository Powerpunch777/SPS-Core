import { describe, expect, it } from "vitest";
import { filterWorkplaneTaskIssues, isWorkplaneRoomOriginKind } from "./workplane-mode";

const profile = {
  roomOriginPrefixes: [
    "plugin:example.rooms:agent-room",
    "plugin:example.rooms:provisioning",
  ],
};

describe("Workplane Task visibility", () => {
  it("recognizes Room origins supplied by the active profile", () => {
    expect(isWorkplaneRoomOriginKind("plugin:example.rooms:agent-room:designer", profile)).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:example.rooms:provisioning", profile)).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:another.rooms:agent-room", profile)).toBe(false);
  });

  it("removes Rooms but keeps finite Worker Tasks in Workplane mode", () => {
    const room = { id: "room", originKind: "plugin:example.rooms:agent-room" };
    const task = { id: "task", originKind: "plugin:example.rooms:role-tool" };
    expect(filterWorkplaneTaskIssues([room, task], true, profile)).toEqual([task]);
    expect(filterWorkplaneTaskIssues([room, task], false)).toEqual([room, task]);
  });
});
