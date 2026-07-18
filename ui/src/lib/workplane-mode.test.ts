import { describe, expect, it } from "vitest";
import { filterWorkplaneTaskIssues, isWorkplaneRoomOriginKind } from "./workplane-mode";

describe("Workplane Task visibility", () => {
  it("recognizes current and legacy long-lived Room origins", () => {
    expect(isWorkplaneRoomOriginKind("plugin:local.room-chat:operation:agent-room")).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:local.room-chat:operation:agent-room:designer")).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:local.room-chat:agent-room-provisioning")).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:local.room-chat:project-room-provisioning")).toBe(true);
    expect(isWorkplaneRoomOriginKind("plugin:local.room-chat:role-tool")).toBe(false);
  });

  it("removes Rooms but keeps finite Worker Tasks in Workplane mode", () => {
    const room = { id: "room", originKind: "plugin:local.room-chat:operation:agent-room" };
    const task = { id: "task", originKind: "plugin:local.room-chat:role-tool" };
    expect(filterWorkplaneTaskIssues([room, task], true)).toEqual([task]);
    expect(filterWorkplaneTaskIssues([room, task], false)).toEqual([room, task]);
  });
});
