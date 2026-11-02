import type { PluginEventBus } from "./plugin-event-bus.js";

/** This lane publishes lifecycle events but owns no event subscriptions. */
export function createSpsWorkspacePluginEventBus(
  shared: PluginEventBus | undefined,
  workspaceId: string,
  pluginKey: string,
): PluginEventBus {
  const unsupported = () => { throw new Error("Workspace Plugin event operation is unavailable."); };
  return Object.freeze({
    async emit(event) {
      if (!shared || event.companyId !== workspaceId || event.actorType !== "plugin"
        || event.actorId !== pluginKey) return unsupported();
      return shared.emit(event);
    },
    forPlugin(key) {
      if (key !== pluginKey) return unsupported();
      return Object.freeze({
        subscribe: unsupported,
        emit: async () => unsupported(),
        // buildHostServices.dispose() may only clear this runtime's resources.
        // No subscriptions are admitted here, so shared Host/B state is untouched.
        clear() {},
      });
    },
    observe: unsupported,
    clearPlugin: unsupported,
    subscriptionCount: () => 0,
  } satisfies PluginEventBus);
}
