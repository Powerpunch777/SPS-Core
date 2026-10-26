import type { PluginRecord } from "../compat/paperclip/shared.js";

export const SPS_PLUGIN_RECOVERY_MODE_ENV = "SPS_PLUGIN_RECOVERY_MODE";

export interface PluginRecoveryState {
  enabled: boolean;
  invalidConfiguration: boolean;
}

export function resolvePluginRecoveryState(value?: string): PluginRecoveryState {
  const configuredValue = arguments.length === 0
    ? process.env[SPS_PLUGIN_RECOVERY_MODE_ENV]
    : value;
  if (configuredValue === undefined || configuredValue === "") {
    return { enabled: false, invalidConfiguration: false };
  }

  return {
    enabled: true,
    invalidConfiguration: configuredValue !== "all-disabled",
  };
}

export function pluginRecoveryMessage(state: PluginRecoveryState): string {
  if (state.invalidConfiguration) {
    return `${SPS_PLUGIN_RECOVERY_MODE_ENV} must be unset or exactly "all-disabled". Plugin code is disabled; correct the setting in the independent Native settings window and restart Core.`;
  }

  return `Plugin recovery mode is active. Plugin code and contributions are disabled; use the independent Native settings window to disable or repair plugins, then clear recovery mode and restart Core.`;
}

export function sendPluginRecoveryResponse(
  res: { status(code: number): { json(body: unknown): unknown } },
  state: PluginRecoveryState,
): void {
  res.status(423).json({
    error: pluginRecoveryMessage(state),
    code: "plugin_recovery_active",
    recoveryMode: "all-disabled",
  });
}

export function assertPluginRuntimeAllowed(
  state: PluginRecoveryState,
  action: string,
): void {
  if (state.enabled) {
    throw new Error(`${pluginRecoveryMessage(state)} Blocked action: ${action}.`);
  }
}

export function isPluginRecoveryStatusRequest(method: string, requestPath: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const normalizedPath = requestPath.replace(/\/+$/, "") || "/";
  if (normalizedPath === "/plugins") return true;

  if (!/^\/plugins\/[^/]+$/.test(normalizedPath)) return false;
  return !new Set([
    "agent-platform",
    "examples",
    "memory-providers",
    "tools",
    "ui-contributions",
  ]).has(normalizedPath.slice("/plugins/".length));
}

export function isPluginRecoveryDisableRequest(method: string, requestPath: string): boolean {
  return method === "POST" && /^\/plugins\/[^/]+\/disable\/?$/.test(requestPath);
}

export function runPluginStartupUnlessRecovering<T>(
  state: PluginRecoveryState,
  start: () => T,
): T | undefined {
  return state.enabled ? undefined : start();
}

export function projectPluginRecoveryStatus(plugin: PluginRecord) {
  return {
    id: plugin.id,
    pluginKey: plugin.pluginKey,
    packageName: plugin.packageName,
    version: plugin.version,
    status: plugin.status,
    installedAt: plugin.installedAt,
    updatedAt: plugin.updatedAt,
    manifestJson: null,
  };
}
