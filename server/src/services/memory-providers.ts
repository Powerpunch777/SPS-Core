import type {
  PaperclipPluginManifestV1,
  PluginMemoryLifecycleEvent,
  PluginMemoryScope,
  PluginRecord,
} from "@paperclipai/shared";

/**
 * Operator-safe view of a ready plugin memory provider. Provider content and
 * credentials never appear here; Core exposes only the declared contract that
 * can be selected for a company or inspected by the Desktop app.
 */
export interface MemoryProviderDescriptor {
  pluginId: string;
  pluginKey: string;
  providerKey: string;
  displayName: string;
  scopes: PluginMemoryScope[];
  lifecycleEvents: PluginMemoryLifecycleEvent[];
  recallToolName: string | null;
  proposeToolName: string | null;
  defaultForNewCompanies: boolean;
}

/**
 * Memory lifecycle events are selected and audited by Core. The worker still
 * registers its local handler through `ctx.events.on`, but the generic event
 * bus must not create a second, unscoped delivery for the same declaration.
 */
export function isCoreManagedMemoryLifecycleSubscription(
  manifest: PaperclipPluginManifestV1 | undefined,
  eventPattern: string,
): boolean {
  return manifest?.memoryProvider?.lifecycleEvents?.includes(
    eventPattern as PluginMemoryLifecycleEvent,
  ) === true;
}

export function isDeclaredMemoryProviderTool(
  provider: MemoryProviderDescriptor,
  toolName: string,
): boolean {
  return provider.recallToolName === toolName || provider.proposeToolName === toolName;
}

export function listReadyMemoryProviders(plugins: PluginRecord[]): MemoryProviderDescriptor[] {
  const seenProviderKeys = new Set<string>();
  const providers: MemoryProviderDescriptor[] = [];
  for (const plugin of plugins) {
    if (plugin.status !== "ready") continue;
    const declaration = plugin.manifestJson.memoryProvider;
    if (!declaration || seenProviderKeys.has(declaration.providerKey)) continue;
    seenProviderKeys.add(declaration.providerKey);
    providers.push({
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      providerKey: declaration.providerKey,
      displayName: declaration.displayName,
      scopes: declaration.scopes,
      lifecycleEvents: declaration.lifecycleEvents ?? [],
      recallToolName: declaration.recallToolName ?? null,
      proposeToolName: declaration.proposeToolName ?? null,
      defaultForNewCompanies: declaration.defaultForNewCompanies === true,
    });
  }
  return providers.sort((left, right) => (
    Number(right.defaultForNewCompanies) - Number(left.defaultForNewCompanies)
    || left.displayName.localeCompare(right.displayName)
  ));
}
