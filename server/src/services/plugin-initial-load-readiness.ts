/**
 * Per-plugin join points for the first ready-plugin loadAll() pass.
 * This is an internal startup coordination primitive, not a runtime state API.
 */
export function createPluginInitialLoadReadiness() {
  let armed = false;
  let claimed = false;
  let published = false;
  let listingReady: Promise<void> | null = null;
  let resolveListingReady: (() => void) | null = null;
  const tasks = new Map<string, Promise<unknown>>();

  function arm(): void {
    if (armed && !published) return;
    armed = true;
    published = false;
    listingReady = new Promise<void>(resolve => { resolveListingReady = resolve; });
  }

  function publish(): void {
    if (!armed || published) return;
    published = true;
    resolveListingReady?.();
    resolveListingReady = null;
  }

  return Object.freeze({
    prepare(): () => void {
      if (!claimed) arm();
      let released = false;
      return () => {
        if (released || claimed) return;
        released = true;
        publish();
      };
    },

    begin(): boolean {
      if (claimed) return false;
      if (!armed || published) arm();
      claimed = true;
      return true;
    },

    register(pluginId: string, task: Promise<unknown>): void {
      if (!armed || !claimed || !listingReady || published) return;
      tasks.set(pluginId, task);
      void task.then(() => {
        if (tasks.get(pluginId) === task) tasks.delete(pluginId);
      }, () => {
        if (tasks.get(pluginId) === task) tasks.delete(pluginId);
      });
    },

    publish(): void {
      publish();
    },

    async wait(pluginId: string): Promise<void> {
      if (!armed) return;
      await listingReady;
      await tasks.get(pluginId)?.catch(() => undefined);
    },
  });
}
