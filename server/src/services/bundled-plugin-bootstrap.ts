import fs from "node:fs";
import path from "node:path";

type PluginManifest = { id: string; version?: string };
type ExistingPlugin = {
  id: string;
  pluginKey: string;
  packagePath?: string | null;
  status: string;
  version?: string | null;
} | null;

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
    uninstall: (pluginId: string, removeData?: boolean) => Promise<unknown>;
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
 * Loads only administrator-provided, image-bundled plugins. A bundle is kept
 * when its version and path are unchanged; otherwise it is soft-reinstalled
 * before loading so Desktop updates can refresh the bundled code without
 * deleting plugin-owned state. Individual plugin failures never prevent the
 * authenticated Hub from starting.
 */
export async function installConfiguredBundledPlugins(
  pluginPaths: readonly string[],
  dependencies: BundledPluginBootstrapDependencies,
  options: { installMissing?: boolean } = {},
): Promise<void> {
  const installMissing = options.installMissing ?? true;
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
      if (!existing && !installMissing) {
        dependencies.logger.info(
          { pluginKey: manifest.id, pluginPath },
          "configured bundled plugin is not installed; skipping refresh",
        );
        continue;
      }
      if (existing) {
        const existingPath = existing.packagePath ? path.resolve(existing.packagePath) : null;
        const hasSameBundle = existing.status === "ready"
          && existing.version === manifest.version
          && existingPath === pluginPath;
        if (hasSameBundle) {
          dependencies.logger.info(
            { pluginId: existing.id, pluginKey: existing.pluginKey, status: existing.status },
            "configured bundled plugin already matches the active bundle; skipping refresh",
          );
          continue;
        }
        dependencies.logger.info(
          {
            pluginId: existing.id,
            pluginKey: existing.pluginKey,
            previousPath: existing.packagePath ?? null,
            previousVersion: existing.version ?? null,
            nextPath: pluginPath,
            nextVersion: manifest.version ?? null,
          },
          "configured bundled plugin changed; refreshing bundle without removing plugin data",
        );
        await dependencies.pluginRegistry.uninstall(existing.id, false);
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
