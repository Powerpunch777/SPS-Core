import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { getSpsDashboardFocusIssues, getSpsTaskStatusLabel } from "./workplane-dashboard";

function issue(id: string, status: Issue["status"]): Issue {
  return { id, status } as Issue;
}

describe("SPS workplane dashboard", () => {
  it("puts blocked and review Tasks ahead of ordinary active work", () => {
    const focus = getSpsDashboardFocusIssues([
      issue("todo", "todo"),
      issue("running", "in_progress"),
      issue("review", "in_review"),
      issue("blocked", "blocked"),
    ]);

    expect(focus.map((entry) => entry.id)).toEqual(["review", "blocked"]);
  });

  it("falls back to active Tasks when nothing needs review", () => {
    const focus = getSpsDashboardFocusIssues([
      issue("done", "done"),
      issue("todo", "todo"),
      issue("running", "in_progress"),
    ]);

    expect(focus.map((entry) => entry.id)).toEqual(["todo", "running"]);
  });

  it("uses concise Korean status labels", () => {
    expect(getSpsTaskStatusLabel("blocked")).toBe("차단됨");
    expect(getSpsTaskStatusLabel("in_review")).toBe("검토 대기");
  });
});
