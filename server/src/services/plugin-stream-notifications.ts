import type { PluginStreamBus } from "./plugin-stream-bus.js";

/** Maps the existing SDK notification protocol without exposing worker selectors. */
export function publishPluginStreamNotification(bus: PluginStreamBus, pluginId: string,
  method: string, params: Record<string, unknown>, generation: string): void {
  if (typeof params.channel !== "string" || typeof params.companyId !== "string") return;
  if (method === "streams.open") bus.publish(pluginId, params.channel, params.companyId, null, "open", generation);
  else if (method === "streams.emit") bus.publish(pluginId, params.channel, params.companyId, params.event, "message", generation);
  else if (method === "streams.close") bus.publish(pluginId, params.channel, params.companyId, null, "close", generation);
}
