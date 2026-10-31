import fs from "node:fs";
import path from "node:path";
import { resolveSpsPluginPackageMetadata } from "./plugin-package-metadata.js";

type PluginManifest = { id: string; version?: string };
type ExistingPlugin = {
  id: string;
  pluginKey: string;
  packagePath?: string | null;
  status: string;
  version?: string | null;
} | null;
const inactiveBundleStatuses = ["disabled", "uninstalled", "upgrade_pending"] as const;
const requiresHostActivation = (plugin: NonNullable<ExistingPlugin>) =>
  inactiveBundleStatuses.some(status => status === plugin.status);

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
    listByStatus: (status: typeof inactiveBundleStatuses[number]) => Promise<NonNullable<ExistingPlugin>[]>;
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
 * authenticated Hub from starting. Disabled, uninstalled and pending-upgrade
 * records need explicit Host activation, including bundles after a Host restore.
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
      // Read identity without importing executable manifest code. Current SPS
      // bundles declare this metadata; legacy bundles remain compatible unless
      // any inactive record could belong to that unknown executable manifest.
      const packageFile = path.join(pluginPath, "package.json");
      if (fs.statSync(packageFile).size > 1024 * 1024) throw new Error("Bundled plugin package metadata is too large.");
      const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8").replace(/^\uFEFF/, ""));
      const declaredIdentity = resolveSpsPluginPackageMetadata(packageJson)?.entrypoints.id;
      if (declaredIdentity !== undefined
        && (typeof declaredIdentity !== "string" || !/^[a-z0-9][a-z0-9.-]{2,127}$/.test(declaredIdentity))) {
        throw new Error("Bundled plugin declarative identity is invalid.");
      }
      let existing = declaredIdentity ? await dependencies.pluginRegistry.getByKey(declaredIdentity) : null;
      if (declaredIdentity) {
        if (existing && requiresHostActivation(existing)) {
          dependencies.logger.info({ pluginKey: declaredIdentity, status: existing.status },
            existing.status === "uninstalled" && !existing.packagePath
              ? "bundled plugin requires new Host review; skipping automatic import"
              : "bundled plugin awaits explicit Host activation; skipping automatic import");
          continue;
        }
        if (!existing && !installMissing) continue;
      } else {
        let hasInactiveRecords = false;
        for (const status of inactiveBundleStatuses) {
          if ((await dependencies.pluginRegistry.listByStatus(status)).length > 0) {
            hasInactiveRecords = true;
            break;
          }
        }
        if (hasInactiveRecords) {
          dependencies.logger.info({ pluginPath }, "legacy bundled identity is unknown while Host review is pending; skipping automatic import");
          continue;
        }
      }
      const manifest = await dependencies.loader.loadManifest(pluginPath);
      if (!manifest?.id) {
        dependencies.logger.warn({ pluginPath }, "configured bundled plugin has no valid manifest; skipping");
        continue;
      }
      if (declaredIdentity && manifest.id !== declaredIdentity) throw new Error("Bundled plugin manifest does not match its declarative identity.");
      if (!declaredIdentity) existing = await dependencies.pluginRegistry.getByKey(manifest.id);
      if (!existing && !installMissing) {
        dependencies.logger.info(
          { pluginKey: manifest.id, pluginPath },
          "configured bundled plugin is not installed; skipping refresh",
        );
        continue;
      }
      if (existing) {
        if (requiresHostActivation(existing)) continue;
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
