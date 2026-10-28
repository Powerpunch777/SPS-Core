import { describe, expect, it, vi } from "vitest";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";

describe("plugin stream bus", () => {
  it("uses collision-safe tuple keys and stale unsubscribe closures cannot remove fresh subscribers", () => {
    const bus = createPluginStreamBus();
    const left = vi.fn();
    const right = vi.fn();
    const oldUnsubscribe = bus.subscribe("a:b", "c", "d", left);
    const freshUnsubscribe = bus.subscribe("a", "b:c", "d", right);

    bus.publish("a:b", "c", "d", { value: 1 });
    bus.publish("a", "b:c", "d", { value: 2 });
    expect(left).toHaveBeenCalledTimes(1);
    expect(right).toHaveBeenCalledTimes(1);

    oldUnsubscribe();
    const listener = vi.fn();
    const staleUnsubscribe = bus.subscribe("plugin", "channel", "company", listener);
    staleUnsubscribe();
    const freshListener = vi.fn();
    bus.subscribe("plugin", "channel", "company", freshListener);
    staleUnsubscribe();
    bus.publish("plugin", "channel", "company", { ok: true });
    expect(bus.subscriberCount("plugin", "channel", "company")).toBe(1);
    expect(freshListener).toHaveBeenCalledTimes(1);
    freshUnsubscribe();
  });

  it("isolates subscribers and publishes an immutable bounded JSON snapshot", () => {
    const bus = createPluginStreamBus();
    const input = { nested: { value: "before" } };
    const observed: unknown[] = [];
    bus.subscribe("plugin", "channel", "company", () => { throw new Error("subscriber failure"); });
    bus.subscribe("plugin", "channel", "company", (event) => observed.push(event));

    expect(() => bus.publish("plugin", "channel", "company", input)).not.toThrow();
    input.nested.value = "after";
    const snapshot = observed[0] as { nested: { value: string } };
    expect(snapshot.nested.value).toBe("before");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(() => bus.publish("plugin", "channel", "company", { value: "x".repeat(64 * 1024) })).toThrow(/64 KiB/);
    expect(() => bus.publish("plugin", "channel", "company", { value: undefined })).toThrow(/JSON/);
  });

  it("requires the active generation to own a channel and closes only that generation", () => {
    const bus = createPluginStreamBus();
    const events: Array<{ event: unknown; type: string }> = [];
    bus.subscribe("plugin", "channel", "company", (event, type) => events.push({ event, type }));

    bus.publish("plugin", "channel", "company", { channel: "channel" }, "open", "generation-a");
    bus.publish("plugin", "channel", "company", { value: "ignored" }, "message", "generation-b");
    expect(() => bus.publish("plugin", "channel", "company", { channel: "channel" }, "open", "generation-b"))
      .toThrow("Plugin stream channel is still owned by another worker generation");
    expect(() => bus.publish("plugin", "channel", "company", { value: "ownerless" }))
      .toThrow("Plugin stream channel requires worker generation ownership");
    expect(bus.ownerChannelCount("plugin", "company", "generation-a")).toBe(1);
    expect(bus.ownerChannelCount("plugin", "company", "generation-b")).toBe(0);

    bus.closeOwner("plugin", "company", "generation-b");
    expect(bus.ownerChannelCount("plugin", "company", "generation-a")).toBe(1);
    bus.publish("plugin", "channel", "company", { value: "ok" }, "message", "generation-a");
    bus.closeOwner("plugin", "company", "generation-a");
    bus.publish("plugin", "channel", "company", { value: "stale" }, "message", "generation-a");
    expect(bus.ownerChannelCount("plugin", "company")).toBe(0);
    expect(events.map(({ type }) => type)).toEqual(["open", "message", "close"]);
    expect(events[2]?.event).toEqual({ channel: "channel", companyId: "company" });
  });

  it("bounds active channels per worker generation", () => {
    const bus = createPluginStreamBus();
    for (let index = 0; index < 64; index++) {
      bus.publish("plugin", `channel-${index}`, "company", {}, "open", "generation-a");
    }
    expect(bus.ownerChannelCount("plugin", "company", "generation-a")).toBe(64);
    expect(() => bus.publish("plugin", "channel-overflow", "company", {}, "open", "generation-a"))
      .toThrow("Plugin stream channel capacity exceeded");
  });

  it("terminally closes ownerless and owned subscriptions once and blocks new admission", () => {
    const bus = createPluginStreamBus();
    const idleEvents: Array<{ event: unknown; type: string }> = [];
    const ownedEvents: Array<{ event: unknown; type: string }> = [];
    const idleShutdown = vi.fn();
    const ownedShutdown = vi.fn();
    let idleUnsubscribe = () => {};
    idleUnsubscribe = bus.subscribe("plugin", "idle", "company", (event, type) => {
      idleEvents.push({ event, type });
      if (type === "close") idleUnsubscribe();
    }, idleShutdown);
    const ownedUnsubscribe = bus.subscribe("plugin", "owned", "company", (event, type) => {
      ownedEvents.push({ event, type });
    }, ownedShutdown);
    bus.publish("plugin", "owned", "company", {}, "open", "generation-a");

    bus.shutdown();
    bus.shutdown();

    expect(idleEvents).toEqual([{ event: { channel: "idle", companyId: "company" }, type: "close" }]);
    expect(ownedEvents).toEqual([
      { event: {}, type: "open" },
      { event: { channel: "owned", companyId: "company" }, type: "close" },
    ]);
    expect(idleShutdown).toHaveBeenCalledTimes(1);
    expect(ownedShutdown).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount("plugin", "idle", "company")).toBe(0);
    expect(bus.subscriberCount("plugin", "owned", "company")).toBe(0);
    expect(bus.ownerChannelCount("plugin", "company")).toBe(0);
    expect(() => bus.subscribe("plugin", "later", "company", vi.fn())).toThrow("Plugin stream bus is shut down");

    idleUnsubscribe();
    ownedUnsubscribe();
    expect(bus.subscriberCount("plugin", "idle", "company")).toBe(0);
    expect(bus.subscriberCount("plugin", "owned", "company")).toBe(0);
    bus.publish("plugin", "idle", "company", { late: true });
    expect(idleEvents).toHaveLength(1);
  });
});
