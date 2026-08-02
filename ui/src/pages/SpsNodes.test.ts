import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import { canManageSpsNodes } from "./SpsNodes";

function access(overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess {
  return {
    user: null,
    userId: "user-1",
    isInstanceAdmin: false,
    isCoreHost: false,
    companyIds: ["workspace-1"],
    source: "session",
    keyId: null,
    ...overrides,
  };
}

describe("canManageSpsNodes", () => {
  it("allows only the local Host bridge in SPS Core baseline mode", () => {
    expect(canManageSpsNodes("workspace-1", access({ source: "local_implicit" }), true)).toBe(true);
    expect(canManageSpsNodes("workspace-1", access({ isInstanceAdmin: true }), true)).toBe(false);
  });

  it("keeps the legacy instance-admin rule outside SPS Core baseline mode", () => {
    expect(canManageSpsNodes("workspace-1", access({ isInstanceAdmin: true }), false)).toBe(true);
  });
});
