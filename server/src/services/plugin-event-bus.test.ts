import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { createPluginEventBus } from "./plugin-event-bus.js";

const event: PluginEvent = {
  eventId: "event-1",
  eventType: "issue.created",
  occurredAt: "2026-07-22T00:00:00.000Z",
  entityId: "issue-1",
  entityType: "issue",
  companyId: "company-1",
  payload: { projectId: "project-1" },
};

describe("PluginEventBus core observers", () => {
  it("delivers Core observers alongside plugin subscriptions and supports disposal", async () => {
    const bus = createPluginEventBus();
    const observer = vi.fn();
    const dispose = bus.observe(observer);

    await bus.emit(event);
    expect(observer).toHaveBeenCalledWith(event);

    dispose();
    await bus.emit({ ...event, eventId: "event-2" });
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("isolates a Core observer failure from other event delivery", async () => {
    const bus = createPluginEventBus();
    const received = vi.fn();
    bus.observe(async () => {
      throw new Error("sidecar unavailable");
    });
    bus.observe(received);

    const result = await bus.emit(event);

    expect(received).toHaveBeenCalledWith(event);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.pluginId).toBe("core.observer");
  });
});
