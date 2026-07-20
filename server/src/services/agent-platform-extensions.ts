import {
  isAgentPlatformContractCompatible,
  type AgentPlatformExtension,
  type PluginRecord,
} from "@paperclipai/shared";

/**
 * Public, credential-free description of a ready Agent Platform extension.
 * The manifest remains the source of truth; this service only filters and
 * normalizes it for settings, installers, and future profile pickers.
 */
export interface AgentPlatformExtensionDescriptor extends AgentPlatformExtension {
  pluginId: string;
  pluginKey: string;
  profileKey: string | null;
}

export function listReadyAgentPlatformExtensions(plugins: PluginRecord[]): AgentPlatformExtensionDescriptor[] {
  return plugins
    .filter((plugin) => plugin.status === "ready")
    .flatMap((plugin) => {
      const declaration = plugin.manifestJson.agentPlatform;
      if (!declaration || !isAgentPlatformContractCompatible(declaration.contractVersion)) return [];
      return [{
        id: plugin.pluginKey,
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        profileKey: declaration.profileKey ?? null,
        contractVersion: declaration.contractVersion,
        kind: declaration.kind,
        displayName: plugin.manifestJson.displayName,
      } satisfies AgentPlatformExtensionDescriptor];
    })
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.displayName.localeCompare(right.displayName));
}
