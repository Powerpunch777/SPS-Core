import type { PluginCompanySettings, PluginRecord } from "@paperclipai/shared";

type PluginCompanyActivationRegistry = {
  getCompanySettings(pluginId: string, companyId: string): Promise<PluginCompanySettings | null>;
  upsertCompanySettings(
    pluginId: string,
    companyId: string,
    input: { enabled?: boolean; settingsJson: Record<string, unknown>; lastError?: string | null },
  ): Promise<PluginCompanySettings>;
};

export type PluginCompanyActivationSource = "default" | "explicit";

export interface PluginCompanyActivation {
  pluginId: string;
  pluginKey: string;
  companyId: string;
  enabled: boolean;
  source: PluginCompanyActivationSource;
  defaultEnabled: boolean;
}

/**
 * Installed plugin code is Host-scoped, but use of that code is Company-scoped.
 * Legacy manifests keep their historical enabled-by-default behavior. New SPS
 * plugins declare this explicitly so a Company starts with only the tools it
 * actually chose.
 */
export function defaultPluginCompanyActivation(plugin: Pick<PluginRecord, "manifestJson">): boolean {
  return plugin.manifestJson.companyActivation?.defaultEnabled ?? true;
}

export async function resolvePluginCompanyActivation(
  registry: PluginCompanyActivationRegistry,
  plugin: Pick<PluginRecord, "id" | "pluginKey" | "manifestJson">,
  companyId: string,
): Promise<PluginCompanyActivation> {
  const settings = await registry.getCompanySettings(plugin.id, companyId);
  const defaultEnabled = defaultPluginCompanyActivation(plugin);
  return {
    pluginId: plugin.id,
    pluginKey: plugin.pluginKey,
    companyId,
    enabled: settings?.enabled ?? defaultEnabled,
    source: settings ? "explicit" : "default",
    defaultEnabled,
  };
}

export async function setPluginCompanyActivation(
  registry: PluginCompanyActivationRegistry,
  plugin: Pick<PluginRecord, "id" | "pluginKey" | "manifestJson">,
  companyId: string,
  enabled: boolean,
): Promise<PluginCompanyActivation> {
  const existing = await registry.getCompanySettings(plugin.id, companyId);
  await registry.upsertCompanySettings(plugin.id, companyId, {
    enabled,
    settingsJson: existing?.settingsJson ?? {},
    lastError: existing?.lastError ?? null,
  });
  return {
    pluginId: plugin.id,
    pluginKey: plugin.pluginKey,
    companyId,
    enabled,
    source: "explicit",
    defaultEnabled: defaultPluginCompanyActivation(plugin),
  };
}
