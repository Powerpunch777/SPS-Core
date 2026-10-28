import { describe, expect, it, vi } from "vitest";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createSpsWorkspacePluginEventBus } from "../services/sps-workspace-plugin-event-bus.js";

const key = "sps.fixture";
const event = { eventId: "memory:fixture", eventType: "memory.task.completed" as const,
  occurredAt: new Date().toISOString(), companyId: "workspace-a", actorType: "plugin" as const,
  actorId: key, payload: {} };

describe("Workspace lifecycle event delivery", () => {
  it("delivers to Core observers without clearing Host or other Workspace subscriptions", async () => {
    const shared = createPluginEventBus();
    const observer = vi.fn();
    const subscriber = vi.fn(async () => {});
    shared.observe(observer);
    shared.forPlugin(key).subscribe("plugin.sps.fixture.changed", subscriber);
    const a = createSpsWorkspacePluginEventBus(shared, "workspace-a", key);
    const b = createSpsWorkspacePluginEventBus(shared, "workspace-b", key);
    await a.emit(event);
    expect(observer).toHaveBeenCalledWith(event);
    a.forPlugin(key).clear();
    b.forPlugin(key).clear();
    expect(shared.subscriptionCount(key)).toBe(1);
    await shared.forPlugin(key).emit("changed", "workspace-b", {});
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it("rejects foreign provenance and unavailable delivery instead of dropping events", async () => {
    const shared = createPluginEventBus();
    const observer = vi.fn();
    shared.observe(observer);
    const a = createSpsWorkspacePluginEventBus(shared, "workspace-a", key);
    await expect(a.emit({ ...event, companyId: "workspace-b" })).rejects.toThrow();
    await expect(a.emit({ ...event, actorId: "other" })).rejects.toThrow();
    await expect(createSpsWorkspacePluginEventBus(undefined, "workspace-a", key).emit(event)).rejects.toThrow();
    expect(() => a.forPlugin(key).subscribe("plugin.sps.fixture.changed", async () => {})).toThrow();
    expect(() => a.clearPlugin(key)).toThrow();
    expect(observer).not.toHaveBeenCalled();
  });
});
