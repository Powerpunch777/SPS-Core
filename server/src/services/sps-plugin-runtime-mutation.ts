/** Core-owned process coordination; independent of package distribution or UI. */
export interface SpsPluginRuntimeMutationCoordinator {
  withPluginMutation<T>(pluginId: string, action: () => Promise<T>): Promise<T>;
  reconcileCatalogPolicy(): Promise<void>;
}

export class SpsPluginRuntimeCleanupPendingError extends Error {
  readonly code = "SPS_PLUGIN_RUNTIME_CLEANUP_PENDING";

  constructor(
    readonly operationStarted: boolean,
    readonly operationCompleted: boolean,
  ) {
    super(operationStarted
      ? "Plugin operation requires refresh because Workspace runtime cleanup is unconfirmed."
      : "Plugin operation did not start because Workspace runtime cleanup is unconfirmed.");
    this.name = "SpsPluginRuntimeCleanupPendingError";
  }
}

// The operation result can contain package paths/manifests. Keep it out of
// enumerable error properties so generic logging/serialization stays safe.
const completedResults = new WeakMap<SpsPluginRuntimeCleanupPendingError, unknown>();

export function getCompletedSpsPluginRuntimeMutationResult(error: unknown): unknown | undefined {
  return error instanceof SpsPluginRuntimeCleanupPendingError && error.operationCompleted
    ? completedResults.get(error)
    : undefined;
}

export async function withSpsPluginRuntimeMutation<T>(
  coordinator: SpsPluginRuntimeMutationCoordinator,
  pluginId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let started = false;
  try {
    return await coordinator.withPluginMutation(pluginId, async () => {
      started = true;
      let result!: T;
      let operationError: unknown;
      let completed = false;
      try {
        result = await operation();
        completed = true;
      } catch (error) {
        operationError = error;
      }
      // Failed operations and rollback can also rotate the global policy token.
      // Reconcile before reopening admission; never replay the mutation.
      try {
        await coordinator.reconcileCatalogPolicy();
      } catch {
        const cleanupError = new SpsPluginRuntimeCleanupPendingError(true, completed);
        if (completed) completedResults.set(cleanupError, result);
        throw cleanupError;
      }
      if (!completed) throw operationError;
      return result;
    });
  } catch (error) {
    if (!started) throw new SpsPluginRuntimeCleanupPendingError(false, false);
    throw error;
  }
}
