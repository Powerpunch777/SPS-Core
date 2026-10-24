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

  it.each(["/", "/?tab=one", "//elsewhere.test", "/../OTHER", "/%2e%2e/OTHER", "/%252e%252e/OTHER", "/builder\\..\\OTHER", "/builder\n", "/%00builder", "/%broken"])("does not redirect the Workspace entry to an unsafe or root route: %s", (route) => {
    expect(workspaceShellRoute(route, "sps")).toBe("/SPS/dashboard");
  });

  it("retains safe plugin child routes, query strings and fragments", () => {
    expect(workspaceShellRoute("/builder/chats/one?view=chat#latest", "sps")).toBe("/SPS/builder/chats/one?view=chat#latest");
  });
});
