const MIN_SPS_PLUGIN_EXECUTION_TIMEOUT_MS = 1_000;
const MAX_SPS_PLUGIN_EXECUTION_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

export function normalizeSpsPluginExecutionTimeout(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("timeout must be a positive safe integer");
  }

  return Math.max(
    MIN_SPS_PLUGIN_EXECUTION_TIMEOUT_MS,
    Math.min(value, MAX_SPS_PLUGIN_EXECUTION_TIMEOUT_MS),
  );
}
