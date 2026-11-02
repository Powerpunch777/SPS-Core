/**
 * In-memory pub/sub bus for plugin SSE streams.
 *
 * Stream ownership is scoped to a worker process generation. This prevents a
 * delayed notification or close from a retired process from affecting a new
 * process that happens to use the same plugin/channel/company tuple.
 */

export type StreamEventType = "message" | "open" | "close" | "error";
export type StreamSubscriber = (event: unknown, eventType: StreamEventType) => void;
type StreamSubscription = { listener: StreamSubscriber; onShutdown?: () => void };

const MAX_CHANNEL_LENGTH = 256;
const MAX_CHANNELS_PER_OWNER = 64;
const MAX_ACTIVE_CHANNELS = 4096;
const MAX_SUBSCRIBED_CHANNELS = 4096;
const MAX_SUBSCRIBERS_PER_CHANNEL = 1024;
const MAX_TOTAL_SUBSCRIBERS = 16_384;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 16_384;

function tupleKey(pluginId: string, channel: string, companyId: string): string {
  return JSON.stringify([pluginId, channel, companyId]);
}

function closeEvent(channel: string, companyId: string): Readonly<{ channel: string; companyId: string }> {
  return Object.freeze({ channel, companyId });
}

function assertIdentifier(value: string, name: string, maxLength: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid stream ${name}`);
  }
}

function immutableJsonSnapshot(value: unknown): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  let estimatedBytes = 2;

  const accountBytes = (value: string): void => {
    estimatedBytes += Buffer.byteLength(value, "utf8") + 2;
    if (estimatedBytes >= MAX_EVENT_BYTES) throw new TypeError("Stream event must be smaller than 64 KiB");
  };

  const check = (input: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES) throw new TypeError("Stream event exceeds the JSON node limit");
    if (depth > MAX_JSON_DEPTH) throw new TypeError("Stream event exceeds the JSON depth limit");
    estimatedBytes += 1;
    if (estimatedBytes >= MAX_EVENT_BYTES) throw new TypeError("Stream event must be smaller than 64 KiB");
    if (input === null || typeof input === "boolean") return;
    if (typeof input === "string") {
      accountBytes(input);
      return;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("Stream event contains a non-finite number");
      return;
    }
    if (typeof input !== "object") throw new TypeError("Stream event must be JSON data");
    if (seen.has(input)) throw new TypeError("Stream event must not contain cycles");
    seen.add(input);

    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) throw new TypeError("Stream arrays must not have custom prototypes");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) {
          throw new TypeError("Stream arrays must not have custom properties");
        }
      }
      for (let index = 0; index < input.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Stream arrays must be dense JSON arrays without accessors");
        }
        check(descriptor.value, depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Stream event must be a plain JSON object");
      const descriptors = Object.getOwnPropertyDescriptors(input);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new TypeError("Stream objects must not contain symbol keys");
        accountBytes(key);
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || key === "toJSON") throw new TypeError("Stream objects must contain only enumerable JSON fields");
        if (!("value" in descriptor)) throw new TypeError("Stream event must not contain accessors");
        check(descriptor.value, depth + 1);
      }
    }
    seen.delete(input);
  };

  check(value, 0);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Stream event must be serializable JSON data");
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") >= MAX_EVENT_BYTES) {
    throw new TypeError("Stream event must be smaller than 64 KiB");
  }
  const snapshot: unknown = JSON.parse(serialized);
  const freeze = (input: unknown): void => {
    if (input === null || typeof input !== "object" || Object.isFrozen(input)) return;
    for (const item of Object.values(input)) freeze(item);
    Object.freeze(input);
  };
  freeze(snapshot);
  return snapshot;
}

interface ActiveOwner {
  readonly generation: string;
}

export interface PluginStreamBus {
  subscribe(pluginId: string, channel: string, companyId: string, listener: StreamSubscriber,
    onShutdown?: () => void): () => void;
  publish(
    pluginId: string,
    channel: string,
    companyId: string,
    event: unknown,
    eventType?: StreamEventType,
    ownerGeneration?: string,
  ): void;
  /** Close all open channels for one exact worker generation. */
  closeOwner(pluginId: string, companyId: string, ownerGeneration: string): void;
  /** Terminally closes admission and all current subscriptions synchronously. */
  shutdown(): void;
  /** Read-only lifecycle counts for bounded diagnostics and tests. */
  subscriberCount(pluginId: string, channel: string, companyId: string): number;
  ownerChannelCount(pluginId: string, companyId: string, ownerGeneration?: string): number;
}

export function createPluginStreamBus(): PluginStreamBus {
  const subscribers = new Map<string, Set<StreamSubscription>>();
  const owners = new Map<string, ActiveOwner>();
  let totalSubscribers = 0;
  let shutDown = false;

  const countOwnerChannels = (pluginId: string, companyId: string, ownerGeneration?: string): number => {
    let count = 0;
    for (const [key, owner] of owners) {
      const tuple = JSON.parse(key) as [string, string, string];
      if (tuple[0] === pluginId && tuple[2] === companyId
        && (ownerGeneration === undefined || owner.generation === ownerGeneration)) count++;
    }
    return count;
  };

  const publishSnapshot = (
    key: string,
    snapshot: unknown,
    eventType: StreamEventType,
  ): void => {
    const set = subscribers.get(key);
    if (!set) return;
    for (const subscription of [...set]) {
      try {
        subscription.listener(snapshot, eventType);
      } catch {
        // A broken SSE client must not block other subscribers or the worker.
      }
    }
  };

  return {
    subscribe(pluginId, channel, companyId, listener, onShutdown) {
      if (shutDown) throw new Error("Plugin stream bus is shut down");
      assertIdentifier(pluginId, "plugin id", 256);
      assertIdentifier(channel, "channel", MAX_CHANNEL_LENGTH);
      assertIdentifier(companyId, "company id", 256);
      if (typeof listener !== "function") throw new TypeError("Stream subscriber must be a function");
      const key = tupleKey(pluginId, channel, companyId);
      let set = subscribers.get(key);
      if (!set) {
        if (subscribers.size >= MAX_SUBSCRIBED_CHANNELS || totalSubscribers >= MAX_TOTAL_SUBSCRIBERS) {
          throw new Error("Plugin stream subscription capacity exceeded");
        }
        set = new Set();
        subscribers.set(key, set);
      }
      const capturedSet = set;
      let subscription = [...capturedSet].find(value => value.listener === listener);
      if (!subscription && (capturedSet.size >= MAX_SUBSCRIBERS_PER_CHANNEL
        || totalSubscribers >= MAX_TOTAL_SUBSCRIBERS)) {
        throw new Error("Too many subscribers for this plugin stream channel");
      }
      if (!subscription) {
        subscription = { listener, ...(onShutdown ? { onShutdown } : {}) };
        capturedSet.add(subscription);
        totalSubscribers++;
      }

      return () => {
        if (capturedSet.delete(subscription!)) totalSubscribers--;
        if (capturedSet.size === 0 && subscribers.get(key) === capturedSet) subscribers.delete(key);
      };
    },

    publish(pluginId, channel, companyId, event, eventType = "message", ownerGeneration) {
      if (shutDown) return;
      assertIdentifier(pluginId, "plugin id", 256);
      assertIdentifier(channel, "channel", MAX_CHANNEL_LENGTH);
      assertIdentifier(companyId, "company id", 256);
      if (!["message", "open", "close", "error"].includes(eventType)) throw new TypeError("Invalid stream event type");
      if (ownerGeneration !== undefined) assertIdentifier(ownerGeneration, "owner generation", 256);
      const key = tupleKey(pluginId, channel, companyId);
      const snapshot = eventType === "close" && ownerGeneration !== undefined
        ? closeEvent(channel, companyId)
        : immutableJsonSnapshot(event);

      if (ownerGeneration === undefined) {
        if (owners.has(key)) throw new Error("Plugin stream channel requires worker generation ownership");
        publishSnapshot(key, snapshot, eventType);
        return;
      }

      const currentOwner = owners.get(key);
      if (eventType === "open") {
        // A new worker cannot silently steal an open stream. The prior owner
        // must close it or retire through closeOwner first.
        if (currentOwner && currentOwner.generation !== ownerGeneration) {
          throw new Error("Plugin stream channel is still owned by another worker generation");
        }
        if (!currentOwner && (countOwnerChannels(pluginId, companyId, ownerGeneration) >= MAX_CHANNELS_PER_OWNER
          || owners.size >= MAX_ACTIVE_CHANNELS)) {
          throw new Error("Plugin stream channel capacity exceeded");
        }
        owners.set(key, { generation: ownerGeneration });
        publishSnapshot(key, snapshot, "open");
        return;
      }
      if (!currentOwner || currentOwner.generation !== ownerGeneration) return;
      if (eventType === "close") owners.delete(key);
      publishSnapshot(key, snapshot, eventType);
    },

    closeOwner(pluginId, companyId, ownerGeneration) {
      if (shutDown) return;
      assertIdentifier(pluginId, "plugin id", 256);
      assertIdentifier(companyId, "company id", 256);
      assertIdentifier(ownerGeneration, "owner generation", 256);
      for (const [key, owner] of owners) {
        if (owner.generation !== ownerGeneration) continue;
        const tuple = JSON.parse(key) as [string, string, string];
        if (tuple[0] !== pluginId || tuple[2] !== companyId) continue;
        owners.delete(key);
        publishSnapshot(key, closeEvent(tuple[1], tuple[2]), "close");
      }
    },

    shutdown() {
      if (shutDown) return;
      shutDown = true;
      for (const [key, set] of [...subscribers]) {
        const [, channel, companyId] = JSON.parse(key) as [string, string, string];
        const snapshot = closeEvent(channel, companyId);
        const activeSubscriptions = [...set];
        publishSnapshot(key, snapshot, "close");
        for (const subscription of activeSubscriptions) {
          try { subscription.onShutdown?.(); } catch { /* Shutdown continues for other streams. */ }
        }
        // Retained unsubscribe closures reference this Set. Empty it so those
        // later calls cannot decrement the already-reset global count.
        set.clear();
      }
      subscribers.clear();
      owners.clear();
      totalSubscribers = 0;
    },

    subscriberCount(pluginId, channel, companyId) {
      return subscribers.get(tupleKey(pluginId, channel, companyId))?.size ?? 0;
    },

    ownerChannelCount(pluginId, companyId, ownerGeneration) {
      return countOwnerChannels(pluginId, companyId, ownerGeneration);
    },
  };
}
