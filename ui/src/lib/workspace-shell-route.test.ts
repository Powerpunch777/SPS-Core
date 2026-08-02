import { describe, expect, it } from "vitest";
import { workspaceShellRoute } from "./workspace-shell-route";

describe("workspaceShellRoute", () => {
  it("keeps unknown plugin routes inside the active company", () => {
    expect(workspaceShellRoute("/discover", "sps")).toBe("/SPS/discover");
  });

  it("uses the company Dashboard when no valid plugin route is selected", () => {
    expect(workspaceShellRoute(null, "cmp")).toBe("/CMP/dashboard");
    expect(workspaceShellRoute("discover", "cmp")).toBe("/CMP/dashboard");
  });

  it("retains a company-relative route until a company is available", () => {
    expect(workspaceShellRoute("/discover", null)).toBe("/discover");
  });
});
