import { describe, expect, it } from "vitest";
import { memoryLifecycleEventForActivity, type LogActivityInput } from "./activity-log.js";

const baseInput: LogActivityInput = {
  companyId: "company-a",
  actorType: "agent",
  actorId: "agent-a",
  agentId: "agent-a",
  runId: "run-a",
  action: "issue.updated",
  entityType: "issue",
  entityId: "task-a",
};

describe("memoryLifecycleEventForActivity", () => {
  it.each([
    ["done", "in_progress", "task.completed"],
    ["blocked", "todo", "task.blocked"],
    ["todo", "blocked", "task.reopened"],
    ["in_review", "cancelled", "task.reopened"],
  ] as const)("maps Task status %s from %s to %s", (status, previousStatus, eventType) => {
    const event = memoryLifecycleEventForActivity(baseInput, {
      status,
      _previous: { status: previousStatus },
      description: "This content must never become memory lifecycle payload.",
    });
    expect(event).toMatchObject({
      eventType,
      entityType: "task",
      entityId: "task-a",
      payload: {
        taskId: "task-a",
        agentId: "agent-a",
        runId: "run-a",
        previousStatus,
        status,
      },
    });
    expect(event?.payload).not.toHaveProperty("description");
  });

  it("maps a published artifact without copying work-product metadata", () => {
    const event = memoryLifecycleEventForActivity({
      ...baseInput,
      action: "issue.work_product_created",
    }, {
      workProductId: "artifact-a",
      type: "artifact",
      provider: "filesystem",
    });
    expect(event).toMatchObject({
      eventType: "artifact.published",
      entityType: "artifact",
      entityId: "artifact-a",
      payload: { taskId: "task-a", artifactId: "artifact-a" },
    });
    expect(event?.payload).not.toHaveProperty("provider");
  });

  it("does not emit when status did not transition or the work product is not an artifact", () => {
    expect(memoryLifecycleEventForActivity(baseInput, {
      status: "done",
      _previous: { status: "done" },
    })).toBeNull();
    expect(memoryLifecycleEventForActivity({
      ...baseInput,
      action: "issue.work_product_created",
    }, {
      workProductId: "document-a",
      type: "document",
    })).toBeNull();
  });
});
