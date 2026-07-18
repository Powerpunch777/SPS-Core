import fs from "node:fs";
import path from "node:path";

type PluginManifest = { id: string };
type ExistingPlugin = { id: string; pluginKey: string; status: string } | null;

type BundledPluginBootstrapDependencies = {
  loader: {
    installPlugin: (input: { localPath: string }) => Promise<{ manifest: PluginManifest | null }>;
    loadManifest: (pluginPath: string) => Promise<PluginManifest | null>;
  };
  lifecycle: {
    load: (pluginId: string) => Promise<unknown>;
  };
  logger: {
    error: (details: unknown, message: string) => void;
    info: (details: unknown, message: string) => void;
    warn: (details: unknown, message: string) => void;
  };
  pluginRegistry: {
    getByKey: (pluginKey: string) => Promise<ExistingPlugin>;
  };
};

export function parseBundledPluginPaths(raw: string | undefined, delimiter = path.delimiter): string[] {
  if (!raw) return [];
  return Array.from(new Set(
    raw
      .split(delimiter)
      .map((value) => value.trim())
      .filter(Boolean),
  ));
}

/**
 * Loads only administrator-provided, image-bundled plugins. Individual plugin
 * failures are logged and never prevent the authenticated Hub from starting.
 */
export async function installConfiguredBundledPlugins(
  pluginPaths: readonly string[],
  dependencies: BundledPluginBootstrapDependencies,
): Promise<void> {
  for (const configuredPath of pluginPaths) {
    const pluginPath = path.resolve(configuredPath);
    try {
      if (!fs.existsSync(path.join(pluginPath, "package.json"))) {
        dependencies.logger.warn({ pluginPath }, "configured bundled plugin path is missing package.json; skipping");
        continue;
      }
      const manifest = await dependencies.loader.loadManifest(pluginPath);
      if (!manifest?.id) {
        dependencies.logger.warn({ pluginPath }, "configured bundled plugin has no valid manifest; skipping");
        continue;
      }
      const existing = await dependencies.pluginRegistry.getByKey(manifest.id);
      if (existing) {
        dependencies.logger.info(
          { pluginId: existing.id, pluginKey: existing.pluginKey, status: existing.status },
          "configured bundled plugin already installed; skipping auto-install",
        );
        continue;
      }
      const discovered = await dependencies.loader.installPlugin({ localPath: pluginPath });
      if (!discovered.manifest?.id) {
        dependencies.logger.warn({ pluginPath }, "configured bundled plugin installed without a manifest; skipping activation");
        continue;
      }
      const installed = await dependencies.pluginRegistry.getByKey(discovered.manifest.id);
      if (!installed) {
        dependencies.logger.warn({ pluginKey: discovered.manifest.id }, "configured bundled plugin was not found after installation");
        continue;
      }
      await dependencies.lifecycle.load(installed.id);
      dependencies.logger.info(
        { pluginId: installed.id, pluginKey: installed.pluginKey },
        "configured bundled plugin auto-installed and loaded",
      );
    } catch (err) {
      dependencies.logger.error(
        { err, pluginPath },
        "failed to auto-install configured bundled plugin; continuing Hub startup",
      );
    }
  }
}
