/**
 * PluginLoader — discovery, installation, and runtime activation of plugins.
 *
 * This service is the entry point for the plugin system's I/O boundary:
 *
 * 1. **Discovery** — Scans the local plugin directory
 *    (`~/.paperclip/plugins/`) and `node_modules` for packages matching
 *    the `paperclip-plugin-*` naming convention. Aggregates results with
 *    path-based deduplication.
 *
 * 2. **Installation** — `installPlugin()` downloads from npm (or reads a
 *    local path), validates the manifest, checks capability consistency,
 *    and persists the install record.
 *
 * 3. **Runtime activation** — `activatePlugin()` wires up a loaded plugin
 *    with all runtime services: resolves its entrypoint, builds
 *    capability-gated host handlers, spawns a worker process, syncs job
 *    declarations, registers event subscriptions, and discovers tools.
 *
 * 4. **Shutdown** — `shutdownAll()` gracefully stops all active workers
 *    and unregisters runtime hooks.
 *
 * @see PLUGIN_SPEC.md §8 — Plugin Discovery
 * @see PLUGIN_SPEC.md §10 — Package Contract
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginLauncherDeclaration,
  PluginRecord,
  PluginUiSlotDeclaration,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { createPluginInitialLoadReadiness } from "./plugin-initial-load-readiness.js";
import type { PluginWorkerManager, WorkerStartOptions, WorkerToHostHandlers } from "./plugin-worker-manager.js";
import type { SpsWorkspacePluginWorkers } from "./sps-workspace-plugin-workers.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginStreamBus } from "./plugin-stream-bus.js";
import { publishPluginStreamNotification } from "./plugin-stream-notifications.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import {
  assertPluginPackageMutationPermit,
  type PluginPackageMutationPermit,
} from "./sps-plugin-package-maintenance.js";
import {
  pluginDatabaseService,
  type PluginDatabaseMigrationPlan,
} from "./plugin-database.js";
import {
  assertRegistryRuntimeArtifactMatchesStatic,
  assertRegistryRuntimeManifestMatchesStatic,
  type RegistryStaticPluginManifest,
} from "./registry-static-manifest.js";
import {
  declaredSpsPluginEntrypoint,
  hasSpsPluginPackageMetadata,
  resolveSpsPluginPackageMetadata,
} from "./plugin-package-metadata.js";
import {
  assertPluginRuntimeAllowed,
  resolvePluginRecoveryState,
  type PluginRecoveryState,
} from "./sps-plugin-recovery.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const BUNDLED_LOCAL_PLUGIN_ROOT = path.join(REPO_ROOT, "packages", "plugins");
export const STANDALONE_BUNDLED_PLUGIN_ROOT = path.join(BUNDLED_LOCAL_PLUGIN_ROOT, "sandbox-providers");
export const LOCAL_PLUGIN_AUTOBUILD_TIMEOUT_MS = 120_000;
const STANDALONE_BUNDLED_PLUGIN_SDK_PACKAGE = "@paperclipai/plugin-sdk";

function npmInvocation(args: string[]) {
  const nodeCommand = process.env.SPS_PLUGIN_NODE_COMMAND?.trim();
  const npmCli = process.env.SPS_PLUGIN_NPM_CLI?.trim();
  if (nodeCommand && npmCli && path.isAbsolute(nodeCommand) && path.isAbsolute(npmCli)) {
    return { file: nodeCommand, args: [npmCli, ...args] };
  }
  return { file: "npm", args };
}

function resolvePnpmCliFromWindowsShim(shimPath: string): string | null {
  let shimContents: string;
  try {
    shimContents = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const shimDirectory = path.dirname(shimPath);
  const cliPaths = shimContents.matchAll(
    /"((?:%~dp0|[A-Za-z]:[\\/])[^"\r\n]*\bpnpm\.(?:cjs|mjs|js))"/gi,
  );
  for (const match of cliPaths) {
    const expandedPath = match[1]!.replace(/%~dp0/gi, `${shimDirectory}${path.sep}`);
    const cliPath = path.resolve(expandedPath.replace(/[\\/]+/g, path.sep));
    if (existsSync(cliPath)) return cliPath;
  }
  return null;
}

export function resolvePnpmInvocation(
  args: readonly string[],
  processEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const configuredPnpmCli = processEnv["SPS_PNPM_CLI"]?.trim();
  const npmExecPath = processEnv["npm_execpath"]?.trim();
  const pnpmCli = configuredPnpmCli
    || (npmExecPath?.toLowerCase().includes("pnpm") ? npmExecPath : "");
  const configuredNodeCommand = processEnv["SPS_PLUGIN_NODE_COMMAND"]?.trim();
  const nodeCommand = configuredNodeCommand
    && path.isAbsolute(configuredNodeCommand)
    && existsSync(configuredNodeCommand)
    ? configuredNodeCommand
    : process.execPath;

  const invocationForCliPath = (cliPath: string) => {
    if (!path.isAbsolute(cliPath) || !existsSync(cliPath)) return null;

    const extension = path.extname(cliPath).toLowerCase();
    if (platform === "win32" && extension === ".exe") {
      return { file: cliPath, args: [...args] };
    }
    if (platform === "win32" && [".cmd", ".bat"].includes(extension)) {
      const resolvedCliPath = resolvePnpmCliFromWindowsShim(cliPath);
      return resolvedCliPath
        ? { file: nodeCommand, args: [resolvedCliPath, ...args] }
        : null;
    }
    return { file: nodeCommand, args: [cliPath, ...args] };
  };

  if (pnpmCli) {
    const invocation = invocationForCliPath(pnpmCli);
    if (invocation) return invocation;
  }

  if (platform === "win32") {
    const pathValue = processEnv["PATH"] ?? processEnv["Path"] ?? "";
    let unresolvedShim: string | null = null;
    for (const entry of pathValue.split(";")) {
      const directory = entry.trim().replace(/^"|"$/g, "");
      if (!directory) continue;

      const executablePath = path.join(directory, "pnpm.exe");
      if (existsSync(executablePath)) {
        return { file: executablePath, args: [...args] };
      }

      for (const extension of [".cmd", ".bat"]) {
        const shimPath = path.join(directory, `pnpm${extension}`);
        if (!existsSync(shimPath)) continue;
        const resolvedCliPath = resolvePnpmCliFromWindowsShim(shimPath);
        if (resolvedCliPath) return { file: nodeCommand, args: [resolvedCliPath, ...args] };
        unresolvedShim ??= shimPath;
      }
    }

    if (unresolvedShim) {
      throw new Error(`Could not resolve the JavaScript CLI referenced by Windows pnpm shim: ${unresolvedShim}`);
    }
    throw new Error("Could not find a directly executable pnpm CLI on Windows PATH; set SPS_PNPM_CLI to its JavaScript entrypoint.");
  }

  return { file: "pnpm", args: [...args] };
}

async function runNpm(args: string[], options: { timeout: number }) {
  const invocation = npmInvocation(args);
  return await execFileAsync(invocation.file, invocation.args, options);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Naming convention for npm-published Paperclip plugins.
 * Packages matching this pattern are considered Paperclip plugins.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export const NPM_PLUGIN_PACKAGE_PREFIX = "paperclip-plugin-";

/**
 * Default local plugin directory.  The loader scans this directory for
 * locally-installed plugin packages.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export const DEFAULT_LOCAL_PLUGIN_DIR = path.join(
  os.homedir(),
  ".paperclip",
  "plugins",
);

const DEV_TSX_LOADER_PATH = path.resolve(__dirname, "../../../cli/node_modules/tsx/dist/loader.mjs");

export function resolveDevTsxLoaderImportSpecifier(): string {
  return pathToFileURL(DEV_TSX_LOADER_PATH).href;
}

/**
 * Model-provider API keys that sandbox-provider plugins (e.g.
 * `@paperclipai/plugin-kubernetes`) are allowed to read from the
 * server's process environment so they can inject them into per-run
 * pod Secrets. All other host env vars remain stripped from plugin
 * workers (see `PluginWorkerManager.spawnProcess`). The passthrough
 * is gated on the plugin manifest declaring
 * `environment.drivers.register` — non-sandbox plugins never receive
 * these keys.
 */
const ADAPTER_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
];

/**
 * In-cluster Kubernetes service-discovery vars. A sandbox-provider plugin that
 * runs in-cluster (e.g. `@paperclipai/plugin-kubernetes` with inCluster=true)
 * builds its API client via `KubeConfig.loadFromCluster()`, which reads these
 * to construct the apiserver URL. Without them the worker fails with "Invalid
 * URL" at lease acquisition. The CA + token are files under
 * /var/run/secrets/kubernetes.io/serviceaccount and are readable directly.
 * Gated, like ADAPTER_ENV_PASSTHROUGH, on environment-driver registration.
 */
const K8S_IN_CLUSTER_ENV_PASSTHROUGH = [
  "KUBERNETES_SERVICE_HOST",
  "KUBERNETES_SERVICE_PORT",
  "KUBERNETES_SERVICE_PORT_HTTPS",
];

/**
 * A bundled memory provider receives only its Owner Host loopback endpoint and
 * per-vault token. The token never reaches unrelated plugin workers.
 */
const MEMORY_PROVIDER_ENV_PASSTHROUGH = [
  "SPS_MEMORY_SIDECAR_URL",
  "SPS_MEMORY_SIDECAR_TOKEN",
];

/**
 * A registry-aware plugin can receive the local path to the Host's verified
 * registry catalog. This catalog contains public release metadata only; it
 * does not grant package installation, lifecycle, or secret access.
 */
const REGISTRY_CATALOG_ENV_PASSTHROUGH = [
  "SPS_PLUGIN_DISCOVERY_CATALOG_PATH",
];

/**
 * A plugin that explicitly integrates with a local Desktop Host may receive
 * only the ephemeral loopback endpoint and access token for that Host. The
 * grant is intentionally separate from outbound HTTP: it is a privileged
 * same-machine capability and never exposes general server secrets.
 */
const LOCAL_HOST_ACCESS_ENV_PASSTHROUGH = [
  "SPS_ROOM_API_URL",
  "SPS_DESKTOP_ACCESS_TOKEN",
];

export function buildPluginWorkerEnv(input: {
  manifest: Pick<PaperclipPluginManifestV1, "capabilities">;
  instanceInfo: { deploymentMode?: string | null; deploymentExposure?: string | null };
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const processEnv = input.processEnv ?? process.env;
  const env: Record<string, string> = {
    PAPERCLIP_DEPLOYMENT_MODE: input.instanceInfo.deploymentMode ?? "",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: input.instanceInfo.deploymentExposure ?? "",
  };
  const canRegisterEnvironmentDrivers = Array.isArray(input.manifest.capabilities)
    && input.manifest.capabilities.includes("environment.drivers.register");
  const canRegisterMemoryProvider = Array.isArray(input.manifest.capabilities)
    && input.manifest.capabilities.includes("memory.providers.register");
  const canReadRegistryCatalog = Array.isArray(input.manifest.capabilities)
    && input.manifest.capabilities.includes("registry.catalog.read");
  const canAccessLocalHost = Array.isArray(input.manifest.capabilities)
    && input.manifest.capabilities.includes("host.local_api.access");
  if (canRegisterEnvironmentDrivers) {
    for (const key of [...ADAPTER_ENV_PASSTHROUGH, ...K8S_IN_CLUSTER_ENV_PASSTHROUGH]) {
      const value = processEnv[key];
      if (value && value.trim().length > 0) {
        env[key] = value;
      }
    }
  }
  if (canRegisterMemoryProvider) {
    for (const key of MEMORY_PROVIDER_ENV_PASSTHROUGH) {
      const value = processEnv[key];
      if (value && value.trim().length > 0) env[key] = value;
    }
  }
  if (canReadRegistryCatalog) {
    for (const key of REGISTRY_CATALOG_ENV_PASSTHROUGH) {
      const value = processEnv[key];
      if (value && value.trim().length > 0) env[key] = value;
    }
  }
  if (canAccessLocalHost) {
    for (const key of LOCAL_HOST_ACCESS_ENV_PASSTHROUGH) {
      const value = processEnv[key];
      if (value && value.trim().length > 0) env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

/**
 * A plugin package found during discovery from any source.
 */
export interface DiscoveredPlugin {
  /** Absolute path to the root of the npm package directory. */
  packagePath: string;
  /** The npm package name as declared in package.json. */
  packageName: string;
  /** Semver version from package.json. */
  version: string;
  /** Source that found this package. */
  source: PluginSource;
  /** The parsed and validated manifest if available, null if discovery-only. */
  manifest: PaperclipPluginManifestV1 | null;
}

/**
 * Sources from which plugins can be discovered.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export type PluginSource =
  | "local-filesystem"  // ~/.paperclip/plugins/ local directory
  | "npm"               // npm packages matching paperclip-plugin-* convention
  | "registry";         // future: remote plugin registry URL

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

/**
 * Result of a discovery scan.
 */
export interface PluginDiscoveryResult {
  /** Plugins successfully discovered and validated. */
  discovered: DiscoveredPlugin[];
  /** Packages found but with validation errors. */
  errors: Array<{ packagePath: string; packageName: string; error: string }>;
  /** Source(s) that were scanned. */
  sources: PluginSource[];
}

type PluginEntrypointKey = "manifest" | "worker" | "ui";

type PluginEntrypointPath = {
  key: PluginEntrypointKey;
  absolutePath: string;
};

type LocalPluginBuildCommand = {
  file: string;
  args: string[];
  cwd: string;
};

function getDeclaredPageRoutePaths(manifest: PaperclipPluginManifestV1): string[] {
  return (manifest.ui?.slots ?? [])
    .filter((slot): slot is PluginUiSlotDeclaration => slot.type === "page" && typeof slot.routePath === "string" && slot.routePath.length > 0)
    .map((slot) => slot.routePath!);
}

// ---------------------------------------------------------------------------
// Loader options
// ---------------------------------------------------------------------------

/**
 * Options for the plugin loader service.
 */
export interface PluginLoaderOptions {
  /**
   * Path to the local plugin directory to scan.
   * Defaults to ~/.paperclip/plugins/
   */
  localPluginDir?: string;

  /** Optional direct Postgres connection used for plugin DDL migrations. */
  migrationDb?: Db;

  /**
   * Whether to scan the local filesystem directory for plugins.
   * Defaults to true.
   */
  enableLocalFilesystem?: boolean;

  /**
   * Whether to discover installed npm packages matching the paperclip-plugin-*
   * naming convention.
   * Defaults to true.
   */
  enableNpmDiscovery?: boolean;

  /** Disable all package inspection and runtime paths during Core recovery. */
  recoveryState?: PluginRecoveryState;

  /**
   * Future: URL of the remote plugin registry to query.
   * When set, the loader will also fetch available plugins from this endpoint.
   * Registry support is not yet implemented; this field is reserved.
   */
  registryUrl?: string;
}

// ---------------------------------------------------------------------------
// Install options
// ---------------------------------------------------------------------------

/**
 * Options for installing a single plugin package.
 */
export interface PluginInstallOptions {
  /**
   * npm package name to install (e.g. "paperclip-plugin-linear" or "@acme/plugin-linear").
   * Either packageName or localPath must be set.
   */
  packageName?: string;

  /**
   * Absolute or relative path to a local plugin directory for development installs.
   * When set, the plugin is loaded from this path without npm install.
   * Either packageName or localPath must be set.
   */
  localPath?: string;

  /**
   * Version specifier passed to npm install (e.g. "^1.2.0", "latest").
   * Ignored when localPath is set.
   */
  version?: string;

  /**
   * Plugin install directory where packages are managed.
   * Defaults to the localPluginDir configured on the service.
   */
  installDir?: string;

  /**
   * Registry packages are staged with a static declaration first. This field
   * is only accepted during an Owner's explicit enable operation and forces
   * the imported runtime manifest to match that reviewed declaration.
   */
  registryStaticManifest?: RegistryStaticPluginManifest;

  /** Do not run local development build recovery for a staged Registry path. */
  skipLocalAutobuild?: boolean;
}

/**
 * An explicit upgrade request. Capability escalation stays denied by default
 * for direct loader callers. A lifecycle operation can set the approval flag
 * only after its own Owner-review boundary has been satisfied.
 */
export interface PluginUpgradeOptions extends Omit<PluginInstallOptions, "installDir"> {
  approvedCapabilityEscalation?: boolean;
  approvedDataMigrationPlanHash?: string;
}

/**
 * Activation-only override used after the Host has reviewed an exact pending
 * plugin database migration plan. The hash is verified again by the database
 * service immediately before SQL can run.
 */
export interface PluginLoadOptions {
  approvedMigrationPlanHash?: string;
}

// ---------------------------------------------------------------------------
// Runtime options — services needed for initializing loaded plugins
// ---------------------------------------------------------------------------

/**
 * Runtime services passed to the loader for plugin initialization.
 *
 * When these are provided, the loader can fully activate plugins (spawn
 * workers, register event subscriptions, sync jobs, register tools).
 * When omitted, the loader operates in discovery/install-only mode.
 *
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export interface PluginRuntimeServices {
  /** Optional catalog-mutation fence for Workspace-owned plugin workers. */
  workspaceRuntime?: Pick<SpsWorkspacePluginWorkers, "withCatalogMutation">;
  streamBus?: PluginStreamBus;
  /** Worker process manager for spawning and managing plugin workers. */
  workerManager: PluginWorkerManager;
  /** Event bus for registering plugin event subscriptions. */
  eventBus: PluginEventBus;
  /** Job scheduler for registering plugin cron jobs. */
  jobScheduler: PluginJobScheduler;
  /** Job store for syncing manifest job declarations to the DB. */
  jobStore: PluginJobStore;
  /** Tool dispatcher for registering plugin-contributed agent tools. */
  toolDispatcher: PluginToolDispatcher;
  /** Lifecycle manager for state transitions and worker lifecycle events. */
  lifecycleManager: PluginLifecycleManager;
  /**
   * Factory that creates worker-to-host RPC handlers for a given plugin.
   *
   * The returned handlers service worker→host calls (e.g. state.get,
   * events.emit, config.get). Each plugin gets its own set of handlers
   * scoped to its capabilities and plugin ID.
   */
  buildHostHandlers: (pluginId: string, manifest: PaperclipPluginManifestV1) => WorkerToHostHandlers;
  /**
   * Host instance information passed to the worker during initialization.
   * Includes the instance ID and host version.
   */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
    deploymentMode?: "local_trusted" | "authenticated";
    deploymentExposure?: "private" | "public";
  };
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

/**
 * Result of activating (loading) a single plugin at runtime.
 *
 * Contains the plugin record, activation status, and any error that
 * occurred during the process.
 */
export interface PluginLoadResult {
  /** The plugin record from the database. */
  plugin: PluginRecord;
  /** Whether the plugin was successfully activated. */
  success: boolean;
  /** Error message if activation failed. */
  error?: string;
  /** Which subsystems were registered during activation. */
  registered: {
    /** True if the worker process was started. */
    worker: boolean;
    /** Number of event subscriptions registered (from manifest event declarations). */
    eventSubscriptions: number;
    /** Number of job declarations synced to the database. */
    jobs: number;
    /** Number of webhook endpoints declared in manifest. */
    webhooks: number;
    /** Number of agent tools registered. */
    tools: number;
  };
}

/**
 * Result of activating all ready plugins at server startup.
 */
export interface PluginLoadAllResult {
  /** Total number of plugins that were attempted. */
  total: number;
  /** Number of plugins successfully activated. */
  succeeded: number;
  /** Number of plugins that failed to activate. */
  failed: number;
  /** Per-plugin results. */
  results: PluginLoadResult[];
}

/**
 * Normalized UI contribution metadata extracted from a plugin manifest.
 *
 * The host serves all plugin UI bundles from the manifest's `entrypoints.ui`
 * directory and currently expects the bundle entry module to be `index.js`.
 */
export interface PluginUiContributionMetadata {
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
  workspaceShell: NonNullable<PaperclipPluginManifestV1["ui"]>["workspaceShell"] | null;
  dashboardWidgets: NonNullable<PaperclipPluginManifestV1["ui"]>["dashboardWidgets"];
}

/**
 * A validated plugin update candidate that has not changed the installed
 * plugin record yet. The lifecycle manager owns the decision to commit it.
 */
export interface PreparedPluginUpgrade {
  oldManifest: PaperclipPluginManifestV1;
  newManifest: PaperclipPluginManifestV1;
  discovered: DiscoveredPlugin;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PluginLoader {
  /**
   * Discover all available plugins from configured sources.
   *
   * This performs a non-destructive scan of all enabled sources and returns
   * the discovered plugins with their parsed manifests.  No installs or DB
   * writes happen during discovery.
   *
   * @param npmSearchDirs - Optional override for node_modules directories to search.
   *   Passed through to discoverFromNpm. When omitted the defaults are used.
   *
   * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Scan the local filesystem plugin directory for installed plugin packages.
   *
   * Reads the plugin directory, attempts to load each subdirectory as an npm
   * package, and validates the plugin manifest.
   *
   * @param dir - Directory to scan (defaults to configured localPluginDir).
   */
  discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult>;

  /**
   * Discover Paperclip plugins installed as npm packages in the current
   * Node.js environment matching the "paperclip-plugin-*" naming convention.
   *
   * Looks for packages in node_modules that match the naming convention.
   *
   * @param searchDirs - node_modules directories to search (defaults to process cwd resolution).
   */
  discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Load and parse the plugin manifest from a package directory.
   *
   * Reads the package.json, finds the manifest entrypoint declared under
   * the SPS package metadata manifest entrypoint, loads the manifest module, and
   * validates it against the plugin manifest schema.
   *
   * Returns null if the package is not an SPS plugin.
   * Throws if the package is an SPS plugin but the manifest is invalid.
   *
   * @see PLUGIN_SPEC.md §10 — Package Contract
   */
  loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null>;

  /**
   * Install a plugin package and register it in the database.
   *
   * Follows the install process described in PLUGIN_SPEC.md §8.3:
   * 1. Resolve npm package / local path.
   * 2. Install into the plugin directory (npm install).
   * 3. Read and validate plugin manifest.
   * 4. Reject incompatible plugin API versions.
   * 5. Validate manifest capabilities.
   * 6. Persist install record in Postgres.
   * 7. Return the discovered plugin for the caller to use.
   *
   * Worker spawning and lifecycle management are handled by the caller
   * (pluginLifecycleManager and the server startup orchestration).
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  installPlugin(options: PluginInstallOptions): Promise<DiscoveredPlugin>;

  /**
   * Imports and validates a Registry package only after an Owner explicitly
   * enables it. This does not persist, migrate, or start the plugin.
   */
  previewRegistryPluginEnable(options: {
    localPath: string;
    staticManifest: RegistryStaticPluginManifest;
  }): Promise<DiscoveredPlugin>;

  /**
   * Upgrade an already-installed plugin to a newer version.
   *
   * Similar to installPlugin, but:
   * 1. Requires the plugin to already exist in the database.
   * 2. Uses the existing packageName if not provided in options.
   * 3. Updates the existing plugin record instead of creating a new one.
   * 4. Returns the old and new manifests for capability comparison.
   *
   * @see PLUGIN_SPEC.md §25.3 — Upgrade Lifecycle
   */
  prepareUpgrade(pluginId: string, options: PluginUpgradeOptions): Promise<PreparedPluginUpgrade>;

  commitPreparedUpgrade(pluginId: string, prepared: PreparedPluginUpgrade): Promise<void>;

  upgradePlugin(pluginId: string, options: PluginUpgradeOptions): Promise<PreparedPluginUpgrade>;

  /**
   * Return a read-only description of pending database work for the installed
   * package. This never creates a namespace or executes plugin SQL.
   */
  inspectPluginMigrations(pluginId: string): Promise<PluginDatabaseMigrationPlan | null>;

  /**
   * Check whether a plugin API version is supported by this host.
   */
  isSupportedApiVersion(apiVersion: number): boolean;

  /**
   * Remove runtime-managed on-disk install artifacts for a plugin.
   *
   * This only cleans files under the managed local plugin directory. Local-path
   * source checkouts outside that directory are intentionally left alone.
   * @internal Caller must first close the target's owned workers and, when
   * `requiresSharedPluginArtifactCleanup(plugin)` is true, hold the exclusive
   * Host package mutation fence for the full lifecycle cleanup transaction.
   */
  cleanupInstallArtifacts(plugin: PluginRecord, permit: PluginPackageMutationPermit): Promise<void>;

  /** Whether cleanup mutates shared npm state and needs the Host package fence. */
  requiresSharedPluginArtifactCleanup(plugin: PluginRecord): boolean;

  /**
   * Get the local plugin directory this loader is configured to use.
   */
  getLocalPluginDir(): string;

  // -----------------------------------------------------------------------
  // Runtime initialization (requires PluginRuntimeServices)
  // -----------------------------------------------------------------------

  /**
   * Load and activate all plugins that are in `ready` status.
   *
   * This is the main server-startup orchestration method. For each plugin
   * that is persisted as `ready`, it:
   * 1. Resolves the worker entrypoint from the manifest.
   * 2. Spawns the worker process via the worker manager.
   * 3. Syncs job declarations from the manifest to the `plugin_jobs` table.
   * 4. Registers the plugin with the job scheduler.
   * 5. Registers event subscriptions declared in the manifest (scoped via the event bus).
   * 6. Registers agent tools from the manifest via the tool dispatcher.
   *
   * Plugins that fail to activate are marked as `error` in the database.
   * Activation failures are non-fatal — other plugins continue loading.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   * Throws if runtime services are not available.
   *
   * @returns Aggregated results for all attempted plugin loads.
   *
   * @see PLUGIN_SPEC.md §8.4 — Server-Start Plugin Loading
   * @see PLUGIN_SPEC.md §12 — Process Model
   */
  loadAll(): Promise<PluginLoadAllResult>;

  /**
   * Arm the initial-load barrier while startup preparation runs before loadAll.
   * The returned release function unblocks waiters if preparation aborts.
   * @internal
   */
  prepareInitialLoad?(): () => void;

  /**
   * Wait for this plugin's initial startup activation, if loadAll has begun.
   * Does not wait for unrelated plugins and is a no-op before initial loading.
   * @internal
   */
  waitForInitialLoad?(pluginId: string): Promise<void>;

  /**
   * Activate a single plugin that is in `installed` or `ready` status.
   *
   * Used after a fresh install (POST /api/plugins/install) or after
   * enabling a previously disabled plugin. Performs the same subsystem
   * registration as `loadAll()` but for a single plugin.
   *
   * If the plugin is in `installed` status, transitions it to `ready`
   * via the lifecycle manager before spawning the worker.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to activate
   * @returns The activation result for this plugin
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  loadSingle(pluginId: string, options?: PluginLoadOptions): Promise<PluginLoadResult>;

  /**
   * Deactivate a single plugin — stop its worker and unregister all
   * subsystem registrations (events, jobs, tools).
   *
   * Used during plugin disable, uninstall, and before upgrade. Does NOT
   * change the plugin's status in the database — that is the caller's
   * responsibility (via the lifecycle manager).
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to deactivate
   * @param pluginKey - The plugin key (manifest ID) for scoped cleanup
   *
   * @see PLUGIN_SPEC.md §8.5 — Uninstall Process
   */
  unloadSingle(pluginId: string, pluginKey: string): Promise<void>;

  /**
   * Stop all managed plugin workers. Called during server shutdown.
   *
   * Stops the job scheduler and then stops all workers via the worker
   * manager. Does NOT change plugin statuses in the database — plugins
   * remain in `ready` so they are restarted on next boot.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   */
  shutdownAll(): Promise<void>;

  /**
   * Whether runtime services are available for plugin activation.
   */
  hasRuntimeServices(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a package name matches the Paperclip plugin naming convention.
 * Accepts both the "paperclip-plugin-" prefix and scoped "@scope/plugin-" packages.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export function isPluginPackageName(name: string): boolean {
  if (name.startsWith(NPM_PLUGIN_PACKAGE_PREFIX)) return true;
  // Also accept scoped packages like @acme/plugin-linear or @paperclipai/plugin-*
  if (name.includes("/")) {
    const localPart = name.split("/")[1] ?? "";
    return localPart.startsWith("plugin-");
  }
  return false;
}

/**
 * Read and parse a package.json from a directory path.
 * Returns null if no package.json exists.
 */
async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown> | null> {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const raw = await readFile(pkgPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildLocalPluginBuildCommand(pkgJson: Record<string, unknown>): string | null {
  const packageName = pkgJson["name"];
  if (typeof packageName !== "string" || packageName.trim().length === 0) return null;
  return `pnpm --filter ${packageName} build`;
}

function readPackageDependencyNames(
  pkgJson: Record<string, unknown>,
  field: "dependencies" | "optionalDependencies",
): string[] {
  const deps = pkgJson[field];
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) return [];
  return Object.keys(deps as Record<string, unknown>);
}

function resolvePackageInstallPath(packageRoot: string, packageName: string): string {
  return path.join(packageRoot, "node_modules", ...packageName.split("/"));
}

function isPathWithin(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isRepoBundledPluginPath(
  packageRoot: string,
  options: { repoRoot?: string } = {},
): boolean {
  const repoPluginsRoot = path.join(options.repoRoot ?? REPO_ROOT, "packages", "plugins");
  return isPathWithin(repoPluginsRoot, packageRoot);
}

export function isStandaloneBundledPluginPath(
  packageRoot: string,
  options: { repoRoot?: string } = {},
): boolean {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  return isPathWithin(path.join(repoRoot, "packages", "plugins", "sandbox-providers"), packageRoot);
}

export function resolveDeclaredPluginEntrypoints(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): PluginEntrypointPath[] {
  const metadata = resolveSpsPluginPackageMetadata(pkgJson);
  if (!metadata) return [];

  const entrypoints: PluginEntrypointPath[] = [];
  for (const key of ["manifest", "worker", "ui"] as const) {
    const relativePath = metadata.entrypoints[key];
    if (typeof relativePath === "string" && relativePath.length > 0) {
      entrypoints.push({
        key,
        absolutePath: path.resolve(packageRoot, relativePath),
      });
    }
  }

  return entrypoints;
}

export function listMissingDeclaredPluginEntrypoints(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): PluginEntrypointPath[] {
  return resolveDeclaredPluginEntrypoints(packageRoot, pkgJson).filter(
    (entrypoint) => !existsSync(entrypoint.absolutePath),
  );
}

function listMissingStandaloneBundledPluginRuntimeDependencies(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): string[] {
  // optionalDependencies are intentionally allowed to be absent (e.g.
  // platform-specific packages), so they must not be treated as required here —
  // otherwise post-build verification fails even when install/build succeeded.
  const dependencyNames = new Set<string>([
    STANDALONE_BUNDLED_PLUGIN_SDK_PACKAGE,
    ...readPackageDependencyNames(pkgJson, "dependencies"),
  ]);

  return [...dependencyNames].filter(
    (packageName) => !existsSync(resolvePackageInstallPath(packageRoot, packageName)),
  );
}

function formatLocalPluginManualBuildHint(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
  options: { processEnv?: NodeJS.ProcessEnv; repoRoot?: string } = {},
): string {
  if (!isRepoBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })) return "";

  const manualBuildCommand = buildLocalPluginRecoveryCommand(packageRoot, pkgJson, { repoRoot: options.repoRoot });
  if (!manualBuildCommand) return "";

  const autoBuildDisabled = (options.processEnv ?? process.env)["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] === "1"
    ? " Auto-build is disabled by PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD=1."
    : "";

  return `${autoBuildDisabled} Run \`${manualBuildCommand}\` from the repo root and retry.`;
}

function buildStandaloneBundledPluginInstallArgs(
  packageRoot: string,
): string[] {
  const packageLockfilePath = path.join(packageRoot, "pnpm-lock.yaml");
  return existsSync(packageLockfilePath)
    ? ["install", "--ignore-workspace", "--frozen-lockfile"]
    : ["install", "--ignore-workspace", "--no-lockfile"];
}

function buildStandaloneBundledPluginInstallCommand(
  packageRoot: string,
): string {
  return `pnpm ${buildStandaloneBundledPluginInstallArgs(packageRoot).join(" ")}`;
}

function buildLocalPluginRecoveryCommand(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
  options: { repoRoot?: string } = {},
): string | null {
  if (isStandaloneBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })) {
    const repoRoot = options.repoRoot ?? REPO_ROOT;
    const relativePath = path.relative(repoRoot, packageRoot) || ".";
    const installCommand = buildStandaloneBundledPluginInstallCommand(packageRoot);
    return `cd ${relativePath} && ${installCommand} && pnpm build`;
  }

  return buildLocalPluginBuildCommand(pkgJson);
}

function buildLocalPluginBuildCommands(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
  options: {
    repoRoot?: string;
    needsBuild?: boolean;
    needsStandaloneRuntimeBootstrap?: boolean;
  } = {},
): LocalPluginBuildCommand[] {
  if (isStandaloneBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })) {
    const commands: LocalPluginBuildCommand[] = [];
    const shouldInstallStandaloneRuntime =
      options.needsStandaloneRuntimeBootstrap === true
      || (!existsSync(path.join(packageRoot, "node_modules")) && options.needsBuild !== false);

    if (shouldInstallStandaloneRuntime) {
      commands.push({
        file: "pnpm",
        args: buildStandaloneBundledPluginInstallArgs(packageRoot),
        cwd: packageRoot,
      });
    }

    if (options.needsBuild !== false) {
      commands.push({
        file: "pnpm",
        args: ["build"],
        cwd: packageRoot,
      });
    }
    return commands;
  }

  const packageName = pkgJson["name"];
  if (typeof packageName !== "string" || packageName.trim().length === 0) return [];
  return [{
    file: "pnpm",
    args: ["--filter", packageName, "build"],
    cwd: options.repoRoot ?? REPO_ROOT,
  }];
}

export async function ensureLocalPluginBuilt(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
  options: {
    processEnv?: NodeJS.ProcessEnv;
    repoRoot?: string;
    execFileAsyncImpl?: (
      file: string,
      args: readonly string[],
      options: { cwd: string; timeout: number },
    ) => Promise<{ stdout: string; stderr: string }>;
  } = {},
): Promise<void> {
  const processEnv = options.processEnv ?? process.env;
  if (processEnv["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] === "1") return;
  if (!isRepoBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })) return;

  const missingEntrypoints = listMissingDeclaredPluginEntrypoints(packageRoot, pkgJson);
  const missingStandaloneRuntimeDeps = isStandaloneBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })
    ? listMissingStandaloneBundledPluginRuntimeDependencies(packageRoot, pkgJson)
    : [];
  if (missingEntrypoints.length === 0 && missingStandaloneRuntimeDeps.length === 0) return;

  const packageName = pkgJson["name"];
  const manualBuildCommand = buildLocalPluginRecoveryCommand(packageRoot, pkgJson, { repoRoot: options.repoRoot });
  if (typeof packageName !== "string" || packageName.trim().length === 0 || !manualBuildCommand) return;

  const runExecFileAsync = options.execFileAsyncImpl ?? execFileAsync;
  const resolveBuildInvocation = options.execFileAsyncImpl
    ? (command: LocalPluginBuildCommand) => command
    : (command: LocalPluginBuildCommand) => (
      command.file === "pnpm"
        ? { ...command, ...resolvePnpmInvocation(command.args, processEnv) }
        : command
    );
  const buildCommands = buildLocalPluginBuildCommands(packageRoot, pkgJson, {
    repoRoot: options.repoRoot,
    needsBuild: missingEntrypoints.length > 0,
    needsStandaloneRuntimeBootstrap: missingStandaloneRuntimeDeps.length > 0,
  });

  try {
    for (const command of buildCommands) {
      const invocation = resolveBuildInvocation(command);
      await runExecFileAsync(
        invocation.file,
        invocation.args,
        { cwd: command.cwd, timeout: LOCAL_PLUGIN_AUTOBUILD_TIMEOUT_MS },
      );
    }
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    const timeoutMessage = (error as { killed?: unknown }).killed === true
      ? ` after timing out at ${LOCAL_PLUGIN_AUTOBUILD_TIMEOUT_MS}ms`
      : "";
    const stderrMessage = stderr.length > 0 ? ` stderr: ${stderr}` : "";
    throw new Error(
      `Failed to auto-build bundled local plugin ${packageName}${timeoutMessage}. ` +
        `Run \`${manualBuildCommand}\` from the repo root and retry.${stderrMessage}`,
    );
  }

  const stillMissingEntrypoints = listMissingDeclaredPluginEntrypoints(packageRoot, pkgJson);
  const stillMissingStandaloneRuntimeDeps = isStandaloneBundledPluginPath(packageRoot, { repoRoot: options.repoRoot })
    ? listMissingStandaloneBundledPluginRuntimeDependencies(packageRoot, pkgJson)
    : [];
  if (stillMissingEntrypoints.length > 0 || stillMissingStandaloneRuntimeDeps.length > 0) {
    const missingDetails: string[] = [];
    if (stillMissingEntrypoints.length > 0) {
      missingDetails.push(`built entrypoints: ${stillMissingEntrypoints.map((entrypoint) => entrypoint.key).join(", ")}`);
    }
    if (stillMissingStandaloneRuntimeDeps.length > 0) {
      missingDetails.push(`runtime dependencies: ${stillMissingStandaloneRuntimeDeps.join(", ")}`);
    }
    throw new Error(
      `Bundled local plugin ${packageName} is still missing ${missingDetails.join("; ")} after auto-build. ` +
        `Run \`${manualBuildCommand}\` from the repo root and retry.`,
    );
  }
}

/**
 * Resolve the manifest entrypoint from a package.json and package root.
 *
 * SPS package metadata defines a "manifest" subkey pointing to the manifest
 * module. `paperclipPlugin` remains a compatibility alias for existing packages.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveManifestPath(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const manifestRelPath = declaredSpsPluginEntrypoint(pkgJson, "manifest");
  if (manifestRelPath) {
    // NOTE: the resolved path is returned as-is even if the file does not yet
    // exist on disk (e.g. the package has not been built). Callers MUST guard
    // with existsSync() before passing the path to loadManifestFromPath().
    return path.resolve(packageRoot, manifestRelPath);
  }

  // Fallback: look for dist/manifest.js as a convention
  const conventionalPath = path.join(packageRoot, "dist", "manifest.js");
  if (existsSync(conventionalPath)) {
    return conventionalPath;
  }

  // Fallback: look for manifest.js at package root
  const rootManifestPath = path.join(packageRoot, "manifest.js");
  if (existsSync(rootManifestPath)) {
    return rootManifestPath;
  }

  return null;
}

function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);
  }

  const coreOrder = (
    ["major", "minor", "patch"] as const
  ).map((key) => leftParsed[key] - rightParsed[key]).find((delta) => delta !== 0);
  if (coreOrder) {
    return coreOrder;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftId = leftParsed.prerelease[index];
    const rightId = rightParsed.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const diff = compareIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}

function getMinimumHostVersion(manifest: PaperclipPluginManifestV1): string | undefined {
  return manifest.minimumHostVersion ?? manifest.minimumPaperclipVersion;
}

/**
 * Extract UI contribution metadata from a manifest for route serialization.
 *
 * Returns `null` when the plugin does not declare any UI slots or launchers.
 * Launcher declarations are aggregated from both the legacy top-level
 * `launchers` field and the preferred `ui.launchers` field.
 */
export function getPluginUiContributionMetadata(
  manifest: PaperclipPluginManifestV1,
): PluginUiContributionMetadata | null {
  const slots = manifest.ui?.slots ?? [];
  const launchers = [
    ...(manifest.launchers ?? []),
    ...(manifest.ui?.launchers ?? []),
  ];

  const workspaceShell = manifest.ui?.workspaceShell ?? null;
  const dashboardWidgets = manifest.ui?.dashboardWidgets ?? [];

  if (slots.length === 0 && launchers.length === 0 && !workspaceShell && dashboardWidgets.length === 0) {
    return null;
  }

  return {
    uiEntryFile: "index.js",
    slots,
    launchers,
    workspaceShell,
    dashboardWidgets,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginLoader service.
 *
 * The loader is responsible for plugin discovery, installation, and runtime
 * activation.  It reads plugin packages from the local filesystem and npm,
 * validates their manifests, registers them in the database, and — when
 * runtime services are provided — initialises worker processes, event
 * subscriptions, job schedules, webhook endpoints, and agent tools.
 *
 * Usage (discovery & install only):
 * ```ts
 * const loader = pluginLoader(db, { enableLocalFilesystem: true });
 *
 * // Discover all available plugins
 * const result = await loader.discoverAll();
 * for (const plugin of result.discovered) {
 *   console.log(plugin.packageName, plugin.manifest?.id);
 * }
 *
 * // Install a specific plugin
 * const discovered = await loader.installPlugin({
 *   packageName: "paperclip-plugin-linear",
 *   version: "^1.0.0",
 * });
 * ```
 *
 * Usage (full runtime activation at server startup):
 * ```ts
 * const loader = pluginLoader(db, loaderOpts, {
 *   workerManager,
 *   eventBus,
 *   jobScheduler,
 *   jobStore,
 *   toolDispatcher,
 *   lifecycleManager,
 *   buildHostHandlers: (pluginId, manifest) => ({ ... }),
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 * });
 *
 * // Load all ready plugins at startup
 * const loadResult = await loader.loadAll();
 * console.log(`Loaded ${loadResult.succeeded}/${loadResult.total} plugins`);
 *
 * // Load a single plugin after install
 * const singleResult = await loader.loadSingle(pluginId);
 *
 * // Shutdown all plugin workers on server exit
 * await loader.shutdownAll();
 * ```
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLoader(
  db: Db,
  options: PluginLoaderOptions = {},
  runtimeServices?: PluginRuntimeServices,
): PluginLoader {
  const {
    localPluginDir = DEFAULT_LOCAL_PLUGIN_DIR,
    migrationDb = db,
    enableLocalFilesystem = true,
    enableNpmDiscovery = true,
  } = options;
  const recoveryState = options.recoveryState ?? resolvePluginRecoveryState();
  const assertRuntimeAllowed = (action: string) => assertPluginRuntimeAllowed(recoveryState, action);

  const registry = pluginRegistryService(db);
  const manifestValidator = pluginManifestValidator();
  const capabilityValidator = pluginCapabilityValidator();
  const log = logger.child({ service: "plugin-loader" });
  const initialLoadReadiness = createPluginInitialLoadReadiness();
  const hostVersion = runtimeServices?.instanceInfo.hostVersion;

  async function assertPageRoutePathsAvailable(manifest: PaperclipPluginManifestV1): Promise<void> {
    const requestedRoutePaths = getDeclaredPageRoutePaths(manifest);
    if (requestedRoutePaths.length === 0) return;

    const uniqueRequested = new Set(requestedRoutePaths);
    if (uniqueRequested.size !== requestedRoutePaths.length) {
      throw new Error(`Plugin ${manifest.id} declares duplicate page routePath values`);
    }

    const installedPlugins = await registry.listInstalled();
    for (const plugin of installedPlugins) {
      if (plugin.pluginKey === manifest.id) continue;
      const installedManifest = plugin.manifestJson as PaperclipPluginManifestV1 | null;
      if (!installedManifest) continue;
      const installedRoutePaths = new Set(getDeclaredPageRoutePaths(installedManifest));
      const conflictingRoute = requestedRoutePaths.find((routePath) => installedRoutePaths.has(routePath));
      if (conflictingRoute) {
        throw new Error(
          `Plugin ${manifest.id} routePath "${conflictingRoute}" conflicts with installed plugin ${plugin.pluginKey}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a plugin from npm or local path, then parse and validate its manifest.
   *
   * This internal helper encapsulates the core plugin retrieval and validation
   * logic used by both install and upgrade operations. It handles:
   * 1. Resolving the package from npm or local filesystem.
   * 2. Installing the package via npm if necessary.
   * 3. Reading and parsing the plugin manifest.
   * 4. Validating API version compatibility.
   * 5. Validating manifest capabilities.
   *
   * @param installOptions - Options specifying the package to fetch.
   * @returns A `DiscoveredPlugin` object containing the validated manifest.
   */
  async function fetchAndValidate(
    installOptions: PluginInstallOptions,
  ): Promise<DiscoveredPlugin> {
    const {
      packageName,
      localPath,
      version,
      installDir,
      registryStaticManifest,
      skipLocalAutobuild,
    } = installOptions;

    if (!packageName && !localPath) {
      throw new Error("Either packageName or localPath must be provided");
    }

    const targetInstallDir = installDir ?? localPluginDir;

    // Step 1 & 2: Resolve and install package
    let resolvedPackagePath: string;
    let resolvedPackageName: string;

    if (localPath) {
      // Local path install — validate the directory exists
      const absLocalPath = path.resolve(localPath);
      if (!existsSync(absLocalPath)) {
        throw new Error(`Local plugin path does not exist: ${absLocalPath}`);
      }
      resolvedPackagePath = absLocalPath;
      const pkgJson = await readPackageJson(absLocalPath);
      resolvedPackageName =
        typeof pkgJson?.["name"] === "string"
          ? pkgJson["name"]
          : path.basename(absLocalPath);

      log.info(
        { localPath: absLocalPath, packageName: resolvedPackageName },
        "plugin-loader: fetching plugin from local path",
      );
    } else {
      // npm install
      if (process.env.SPS_DESKTOP_PLUGIN_RUNTIME === "local-folder-only") {
        throw new Error(
          "SPS Desktop cannot install npm plugins because npm is unavailable on this computer. Install Node.js and restart SPS Desktop, or install a local-folder plugin instead.",
        );
      }
      const spec = version ? `${packageName}@${version}` : packageName!;

      log.info(
        { spec, installDir: targetInstallDir },
        "plugin-loader: fetching plugin from npm",
      );

      try {
        // Use execFile (not exec) to avoid shell injection from package name/version.
        // --ignore-scripts prevents preinstall/install/postinstall hooks from
        // executing arbitrary code on the host before manifest validation.
        await runNpm(
          ["install", spec, "--prefix", targetInstallDir, "--save", "--ignore-scripts"],
          { timeout: 120_000 }, // 2 minute timeout for npm install
        );
      } catch (err) {
        throw new Error(`npm install failed for ${spec}: ${String(err)}`);
      }

      // Resolve the package path after installation
      const nodeModulesPath = path.join(targetInstallDir, "node_modules");
      resolvedPackageName = packageName!;

      // Handle scoped packages
      if (resolvedPackageName.startsWith("@")) {
        const [scope, name] = resolvedPackageName.split("/");
        resolvedPackagePath = path.join(nodeModulesPath, scope!, name!);
      } else {
        resolvedPackagePath = path.join(nodeModulesPath, resolvedPackageName);
      }

      if (!existsSync(resolvedPackagePath)) {
        throw new Error(
          `Package directory not found after installation: ${resolvedPackagePath}`,
        );
      }
    }

    // Step 3: Read and validate plugin manifest
    // Note: this.loadManifest (used via current context)
    const pkgJson = await readPackageJson(resolvedPackagePath);
    if (!pkgJson) throw new Error(`Missing package.json at ${resolvedPackagePath}`);

    if (localPath && !skipLocalAutobuild) {
      await ensureLocalPluginBuilt(resolvedPackagePath, pkgJson);
    }

    const manifestPath = resolveManifestPath(resolvedPackagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      const manualBuildHint = localPath
        ? formatLocalPluginManualBuildHint(resolvedPackagePath, pkgJson)
        : "";
      throw new Error(
        `Package ${resolvedPackageName} at ${resolvedPackagePath} does not appear to be a Paperclip plugin (no manifest found).${manualBuildHint}`,
      );
    }

    // A Registry package's runtime source must match the previously reviewed
    // static declaration before dynamic import can execute its module body.
    if (registryStaticManifest) {
      await assertRegistryRuntimeArtifactMatchesStatic({
        packageRoot: resolvedPackagePath,
        manifestPath,
        staticManifest: registryStaticManifest,
      });
    }

    const manifest = await loadManifestFromPath(manifestPath);

    if (registryStaticManifest) {
      await assertRegistryRuntimeManifestMatchesStatic({
        packageRoot: resolvedPackagePath,
        manifestPath,
        staticManifest: registryStaticManifest,
        runtimeManifest: manifest,
      });
    }

    // Step 4: Reject incompatible plugin API versions
    if (!manifestValidator.getSupportedVersions().includes(manifest.apiVersion)) {
      throw new Error(
        `Plugin ${manifest.id} declares apiVersion ${manifest.apiVersion} which is not supported by this host. ` +
          `Supported versions: ${manifestValidator.getSupportedVersions().join(", ")}`,
      );
    }

    // Step 5: Validate manifest capabilities are consistent
    const capResult = capabilityValidator.validateManifestCapabilities(manifest);
    if (!capResult.allowed) {
      throw new Error(
        `Plugin ${manifest.id} manifest has inconsistent capabilities. ` +
          `Missing required capabilities for declared features: ${capResult.missing.join(", ")}`,
      );
    }

    await assertPageRoutePathsAvailable(manifest);

    // Step 6: Reject plugins that require a newer host than the running server
    const minimumHostVersion = getMinimumHostVersion(manifest);
    if (minimumHostVersion && hostVersion) {
      if (compareSemver(hostVersion, minimumHostVersion) < 0) {
        throw new Error(
          `Plugin ${manifest.id} requires host version ${minimumHostVersion} or newer, ` +
            `but this server is running ${hostVersion}`,
        );
      }
    }

    // Use the version declared in the manifest (required field per the spec)
    const resolvedVersion = manifest.version;

    return {
      packagePath: resolvedPackagePath,
      packageName: resolvedPackageName,
      version: resolvedVersion,
      source: localPath ? "local-filesystem" : "npm",
      manifest,
    };
  }

  /**
   * Attempt to load and validate a plugin manifest from a resolved path.
   * Returns the manifest on success or throws with a descriptive error.
   */
  async function loadManifestFromPath(
    manifestPath: string,
  ): Promise<PaperclipPluginManifestV1> {
    let raw: unknown;

    try {
      // Dynamic import works for both .js (ESM) and .cjs (CJS) manifests
      const manifestUrl = pathToFileURL(manifestPath);
      const manifestStat = await stat(manifestPath);
      manifestUrl.searchParams.set("mtime", String(Math.trunc(manifestStat.mtimeMs)));
      const mod = await import(manifestUrl.href) as Record<string, unknown>;
      // The manifest may be the default export or the module itself
      raw = mod["default"] ?? mod;
    } catch (err) {
      throw new Error(
        `Failed to load manifest module at ${manifestPath}: ${String(err)}`,
      );
    }

    return manifestValidator.parseOrThrow(raw);
  }

  async function loadManifestFromPackageRoot(
    packageRoot: string,
  ): Promise<PaperclipPluginManifestV1 | null> {
    const pkgJson = await readPackageJson(packageRoot);
    if (!pkgJson) return null;

    const manifestPath = resolveManifestPath(packageRoot, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) return null;

    return loadManifestFromPath(manifestPath);
  }

  async function refreshPluginManifestFromPackage(
    plugin: PluginRecord,
    packageRoot: string,
  ): Promise<PluginRecord> {
    const manifest = await loadManifestFromPackageRoot(packageRoot);
    if (!manifest) {
      throw new Error(`Plugin package ${plugin.packageName} no longer exposes a Paperclip manifest`);
    }
    if (manifest.id !== plugin.pluginKey) {
      throw new Error(
        `Plugin manifest ID '${manifest.id}' does not match installed plugin '${plugin.pluginKey}'`,
      );
    }

    if (JSON.stringify(manifest) === JSON.stringify(plugin.manifestJson)) {
      return plugin;
    }

    await registry.update(plugin.id, {
      packageName: plugin.packageName,
      version: manifest.version,
      manifest,
    });

    return {
      ...plugin,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
    };
  }

  /**
   * Build a DiscoveredPlugin from a resolved package directory, or null
   * if the package is not a Paperclip plugin.
   */
  async function buildDiscoveredPlugin(
    packagePath: string,
    source: PluginSource,
  ): Promise<DiscoveredPlugin | null> {
    const pkgJson = await readPackageJson(packagePath);
    if (!pkgJson) return null;

    const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
    const version = typeof pkgJson["version"] === "string" ? pkgJson["version"] : "0.0.0";

    // Determine if this is a plugin package at all
    const hasPluginMetadata = hasSpsPluginPackageMetadata(pkgJson);
    const nameMatchesConvention = isPluginPackageName(packageName);

    if (!hasPluginMetadata && !nameMatchesConvention) {
      return null;
    }

    const manifestPath = resolveManifestPath(packagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      // Found a potential plugin package but no manifest entry point — treat
      // as a discovery-only result with no manifest
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest: null,
      };
    }

    try {
      const manifest = await loadManifestFromPath(manifestPath);
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest,
      };
    } catch (err) {
      // Rethrow with context — callers catch and route to the errors array
      throw new Error(
        `Plugin ${packageName}: ${String(err)}`,
      );
    }
  }

  async function preparePluginUpgrade(
    pluginId: string,
    upgradeOptions: PluginUpgradeOptions,
  ): Promise<PreparedPluginUpgrade> {
    const plugin = (await registry.getById(pluginId)) as {
      id: string;
      packageName: string;
      packagePath: string | null;
      manifestJson: PaperclipPluginManifestV1;
    } | null;
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

    const oldManifest = plugin.manifestJson;
    const packageName = upgradeOptions.packageName ?? plugin.packageName;
    if (plugin.packagePath && isUnderManagedStagingRoot(plugin.packagePath, localPluginDir)) {
      const staged = classifyStagedPackagePath(plugin.packagePath, localPluginDir, plugin.packageName);
      if (!staged.underStaging || !staged.root) throw new Error("Refusing to use an unrecognized staged plugin package path");
    }
    const localPath = upgradeOptions.localPath
      ?? (plugin.packagePath && !isManagedNpmPackagePath(plugin.packagePath, localPluginDir, plugin.packageName)
        ? plugin.packagePath
        : undefined);
    const { version } = upgradeOptions;

    log.info(
      { pluginId, packageName, version, localPath },
      "plugin-loader: preparing plugin upgrade",
    );

    // An upgrade candidate must never overwrite the active artifact while it
    // is still being parsed, imported, and capability-checked. Keep both npm
    // and local development candidates in a private staging directory until
    // the lifecycle commits the replacement.
    const stagingDir = path.join(
      localPluginDir,
      ".upgrade-staging",
      pluginId,
      randomUUID(),
    );
    let stagedLocalPath: string | undefined;

    try {
      if (localPath) {
        const sourcePath = path.resolve(localPath);
        stagedLocalPath = path.join(stagingDir, "package");
        await mkdir(stagingDir, { recursive: true });
        await cp(sourcePath, stagedLocalPath, {
          recursive: true,
          // Symlink targets must remain outside the candidate boundary only
          // when the package itself explicitly uses a symlink. Do not resolve
          // them while copying so validation observes the package faithfully.
          dereference: false,
          force: true,
          errorOnExist: true,
        });
      }

      const discovered = await fetchAndValidate({
        ...upgradeOptions,
        packageName,
        localPath: stagedLocalPath,
        version,
        installDir: stagingDir,
      });
      const newManifest = discovered.manifest!;

      if (newManifest.id !== oldManifest.id) {
        throw new Error(
          `Upgrade failed: new manifest ID '${newManifest.id}' does not match existing plugin ID '${oldManifest.id}'`,
        );
      }

      return { oldManifest, newManifest, discovered };
    } catch (error) {
      // A rejected candidate is not part of the installed plugin state.
      // Removing only this UUID-scoped staging directory cannot affect the
      // active package, which remains at its pre-upgrade packagePath.
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async function commitPreparedPluginUpgrade(
    pluginId: string,
    prepared: PreparedPluginUpgrade,
  ): Promise<void> {
    await registry.update(pluginId, {
      packageName: prepared.discovered.packageName,
      packagePath: prepared.discovered.packagePath,
      version: prepared.discovered.version,
      manifest: prepared.newManifest,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    // -----------------------------------------------------------------------
    // discoverAll
    // -----------------------------------------------------------------------

    async discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult> {
      assertRuntimeAllowed("plugin discovery");
      const allDiscovered: DiscoveredPlugin[] = [];
      const allErrors: Array<{ packagePath: string; packageName: string; error: string }> = [];
      const sources: PluginSource[] = [];

      if (enableLocalFilesystem) {
        sources.push("local-filesystem");
        const fsResult = await this.discoverFromLocalFilesystem();
        allDiscovered.push(...fsResult.discovered);
        allErrors.push(...fsResult.errors);
      }

      if (enableNpmDiscovery) {
        sources.push("npm");
        const npmResult = await this.discoverFromNpm(npmSearchDirs);
        // Deduplicate against already-discovered packages (same package path)
        const existingPaths = new Set(allDiscovered.map((d) => d.packagePath));
        for (const plugin of npmResult.discovered) {
          if (!existingPaths.has(plugin.packagePath)) {
            allDiscovered.push(plugin);
          }
        }
        allErrors.push(...npmResult.errors);
      }

      // Future: registry source (options.registryUrl)
      if (options.registryUrl) {
        sources.push("registry");
        log.warn(
          { registryUrl: options.registryUrl },
          "plugin-loader: remote registry discovery is not yet implemented",
        );
      }

      log.info(
        {
          discovered: allDiscovered.length,
          errors: allErrors.length,
          sources,
        },
        "plugin-loader: discovery complete",
      );

      return { discovered: allDiscovered, errors: allErrors, sources };
    },

    // -----------------------------------------------------------------------
    // discoverFromLocalFilesystem
    // -----------------------------------------------------------------------

    async discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult> {
      assertRuntimeAllowed("local plugin discovery");
      const scanDir = dir ?? localPluginDir;
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      if (!existsSync(scanDir)) {
        log.debug(
          { dir: scanDir },
          "plugin-loader: local plugin directory does not exist, skipping",
        );
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      let entries: string[];
      try {
        entries = await readdir(scanDir);
      } catch (err) {
        log.warn({ dir: scanDir, err }, "plugin-loader: failed to read local plugin directory");
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      for (const entry of entries) {
        const entryPath = path.join(scanDir, entry);

        // Check if entry is a directory
        let entryStat;
        try {
          entryStat = await stat(entryPath);
        } catch {
          continue;
        }
        if (!entryStat.isDirectory()) continue;

        // Handle scoped packages: @scope/plugin-name is a subdirectory
        if (entry.startsWith("@")) {
          let scopedEntries: string[];
          try {
            scopedEntries = await readdir(entryPath);
          } catch {
            continue;
          }
          for (const scopedEntry of scopedEntries) {
            const scopedPath = path.join(entryPath, scopedEntry);
            try {
              const scopedStat = await stat(scopedPath);
              if (!scopedStat.isDirectory()) continue;
              const plugin = await buildDiscoveredPlugin(scopedPath, "local-filesystem");
              if (plugin) discovered.push(plugin);
            } catch (err) {
              errors.push({
                packagePath: scopedPath,
                packageName: `${entry}/${scopedEntry}`,
                error: String(err),
              });
            }
          }
          continue;
        }

        try {
          const plugin = await buildDiscoveredPlugin(entryPath, "local-filesystem");
          if (plugin) discovered.push(plugin);
        } catch (err) {
          const pkgJson = await readPackageJson(entryPath);
          const packageName =
            typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
          errors.push({ packagePath: entryPath, packageName, error: String(err) });
        }
      }

      log.debug(
        { dir: scanDir, discovered: discovered.length, errors: errors.length },
        "plugin-loader: local filesystem scan complete",
      );

      return { discovered, errors, sources: ["local-filesystem"] };
    },

    // -----------------------------------------------------------------------
    // discoverFromNpm
    // -----------------------------------------------------------------------

    async discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult> {
      assertRuntimeAllowed("npm plugin discovery");
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      // Determine the node_modules directories to search.
      // When searchDirs is undefined OR empty, fall back to the conventional
      // defaults (cwd/node_modules and localPluginDir/node_modules).
      // To search nowhere explicitly, pass a non-empty array of non-existent paths.
      const dirsToSearch: string[] = searchDirs && searchDirs.length > 0 ? searchDirs : [];

      if (dirsToSearch.length === 0) {
        // Default: search node_modules relative to the process working directory
        // and also the local plugin dir's node_modules
        const cwdNodeModules = path.join(process.cwd(), "node_modules");
        const localNodeModules = path.join(localPluginDir, "node_modules");

        if (existsSync(cwdNodeModules)) dirsToSearch.push(cwdNodeModules);
        if (existsSync(localNodeModules)) dirsToSearch.push(localNodeModules);
      }

      for (const nodeModulesDir of dirsToSearch) {
        if (!existsSync(nodeModulesDir)) continue;

        let entries: string[];
        try {
          entries = await readdir(nodeModulesDir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          const entryPath = path.join(nodeModulesDir, entry);

          // Handle scoped packages (@scope/*)
          if (entry.startsWith("@")) {
            let scopedEntries: string[];
            try {
              scopedEntries = await readdir(entryPath);
            } catch {
              continue;
            }
            for (const scopedEntry of scopedEntries) {
              const fullName = `${entry}/${scopedEntry}`;
              if (!isPluginPackageName(fullName)) continue;

              const scopedPath = path.join(entryPath, scopedEntry);
              try {
                const plugin = await buildDiscoveredPlugin(scopedPath, "npm");
                if (plugin) discovered.push(plugin);
              } catch (err) {
                errors.push({
                  packagePath: scopedPath,
                  packageName: fullName,
                  error: String(err),
                });
              }
            }
            continue;
          }

          // Non-scoped packages: check naming convention
          if (!isPluginPackageName(entry)) continue;

          let entryStat;
          try {
            entryStat = await stat(entryPath);
          } catch {
            continue;
          }
          if (!entryStat.isDirectory()) continue;

          try {
            const plugin = await buildDiscoveredPlugin(entryPath, "npm");
            if (plugin) discovered.push(plugin);
          } catch (err) {
            const pkgJson = await readPackageJson(entryPath);
            const packageName =
              typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
            errors.push({ packagePath: entryPath, packageName, error: String(err) });
          }
        }
      }

      log.debug(
        { searchDirs: dirsToSearch, discovered: discovered.length, errors: errors.length },
        "plugin-loader: npm discovery scan complete",
      );

      return { discovered, errors, sources: ["npm"] };
    },

    // -----------------------------------------------------------------------
    // loadManifest
    // -----------------------------------------------------------------------

    async loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null> {
      assertRuntimeAllowed("plugin manifest import");
      const pkgJson = await readPackageJson(packagePath);
      if (!pkgJson) return null;

      const hasPluginMetadata = hasSpsPluginPackageMetadata(pkgJson);
      const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
      const nameMatchesConvention = isPluginPackageName(packageName);

      if (!hasPluginMetadata && !nameMatchesConvention) {
        return null;
      }

      const manifestPath = resolveManifestPath(packagePath, pkgJson);
      if (!manifestPath || !existsSync(manifestPath)) return null;

      return loadManifestFromPath(manifestPath);
    },

    // -----------------------------------------------------------------------
    // installPlugin
    // -----------------------------------------------------------------------

    async installPlugin(installOptions: PluginInstallOptions): Promise<DiscoveredPlugin> {
      assertRuntimeAllowed("plugin installation");
      const performInstall = async () => {
        const ownsStagingRoot = Boolean(installOptions.packageName && !installOptions.localPath);
        const stagingRoot = ownsStagingRoot
          ? path.join(localPluginDir, ".install-staging", randomUUID())
          : null;
        let commitMayHaveBeenAttempted = false;
        try {
          if (stagingRoot) await mkdir(stagingRoot, { recursive: true });
          const discovered = await fetchAndValidate(stagingRoot
            ? { ...installOptions, installDir: stagingRoot }
            : installOptions);
          const manifest = discovered.manifest!;

          // Persist the exact package root used for validation. npm packages
          // are installed under their UUID-owned staging root so npm never
          // reifies the shared active node_modules tree during a new install.
          const installDb = manifest.database ? migrationDb : db;
          await installDb.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const txRegistry = pluginRegistryService(txDb);
            const installed = await txRegistry.install(
              {
                packageName: discovered.packageName,
                packagePath: discovered.packagePath,
              },
              manifest,
            );

            if (!installed) {
              throw new Error(`Plugin install did not return a registry row: ${manifest.id}`);
            }

            if (manifest.database) {
              await pluginDatabaseService(txDb).applyMigrations(
                installed.id,
                manifest,
                discovered.packagePath,
                { persistFailure: false },
              );
            }
            // The driver sends COMMIT only after this callback resolves. A
            // later rejection can mean the commit response was lost, so it
            // cannot prove that the registry did not adopt this package.
            commitMayHaveBeenAttempted = true;
          });

          log.info(
            {
              pluginId: manifest.id,
              packageName: discovered.packageName,
              version: discovered.version,
              capabilities: manifest.capabilities,
            },
            "plugin-loader: plugin installed successfully",
          );

          return discovered;
        } catch (error) {
          // Clean only failures before COMMIT can have been attempted. Keep an
          // uncertain artifact available for recovery rather than deleting a
          // package that the registry may already reference.
          if (stagingRoot && !commitMayHaveBeenAttempted) {
            await rm(stagingRoot, { recursive: true, force: true });
          }
          throw error;
        }
      };
      return runtimeServices?.workspaceRuntime
        ? await runtimeServices.workspaceRuntime.withCatalogMutation(performInstall)
        : await performInstall();
    },

    async previewRegistryPluginEnable({ localPath, staticManifest }): Promise<DiscoveredPlugin> {
      assertRuntimeAllowed("Registry plugin import");
      return await fetchAndValidate({
        localPath,
        registryStaticManifest: staticManifest,
        skipLocalAutobuild: true,
      });
    },

    // -----------------------------------------------------------------------
    // upgradePlugin
    // -----------------------------------------------------------------------

    /**
     * Upgrade an already-installed plugin to a newer version.
     *
     * This method:
     * 1. Fetches and validates the new plugin package using `fetchAndValidate`.
     * 2. Ensures the new manifest ID matches the existing plugin ID for safety.
     * 3. Updates the plugin record in the registry with the new version and manifest.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param upgradeOptions - Options for the upgrade (packageName, localPath, version).
     * @returns The old and new manifests, along with the discovery metadata.
     * @throws {Error} If the plugin is not found or if the new manifest ID differs.
     */
    async upgradePlugin(
      pluginId: string,
      upgradeOptions: PluginUpgradeOptions,
    ): Promise<PreparedPluginUpgrade> {
      assertRuntimeAllowed("plugin upgrade");
      const prepared = await preparePluginUpgrade(pluginId, upgradeOptions);
      const oldCapabilities = new Set(prepared.oldManifest.capabilities ?? []);
      const escalated = (prepared.newManifest.capabilities ?? []).filter(capability => !oldCapabilities.has(capability));
      if (escalated.length > 0 && !upgradeOptions.approvedCapabilityEscalation) {
        await removeOwnedStagedArtifact(prepared.discovered.packagePath, prepared.discovered.packageName, localPluginDir);
        throw new Error(
          `Upgrade for "${pluginId}" introduces new capabilities that require approval: ${escalated.join(", ")}. ` +
            `The previous version declared [${[...oldCapabilities].join(", ")}]. ` +
            `Please review and approve the capability escalation before upgrading.`,
        );
      }

      // This write is autocommitted. A rejected response does not establish
      // that it rolled back; preserve the candidate in either outcome so a
      // committed registry pointer never references an artifact we removed.
      await registry.update(pluginId, {
        packageName: prepared.discovered.packageName,
        packagePath: prepared.discovered.packagePath,
        version: prepared.discovered.version,
        manifest: prepared.newManifest,
      });
      return prepared;
    },

    async prepareUpgrade(
      pluginId: string,
      upgradeOptions: PluginUpgradeOptions,
    ): Promise<PreparedPluginUpgrade> {
      assertRuntimeAllowed("plugin upgrade preparation");
      return await preparePluginUpgrade(pluginId, upgradeOptions);
    },

    async commitPreparedUpgrade(
      pluginId: string,
      prepared: PreparedPluginUpgrade,
    ): Promise<void> {
      assertRuntimeAllowed("plugin upgrade commit");
      await commitPreparedPluginUpgrade(pluginId, prepared);
    },

    async inspectPluginMigrations(pluginId: string): Promise<PluginDatabaseMigrationPlan | null> {
      assertRuntimeAllowed("plugin migration inspection");
      const plugin = (await registry.getById(pluginId)) as PluginRecord | null;
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
      const packageRoot = resolvePluginPackageRoot(plugin, localPluginDir);
      const manifest = await loadManifestFromPackageRoot(packageRoot);
      if (!manifest) {
        throw new Error(`Plugin package ${plugin.packageName} no longer exposes a Paperclip manifest`);
      }
      if (manifest.id !== plugin.pluginKey) {
        throw new Error(`Plugin manifest ID '${manifest.id}' does not match installed plugin '${plugin.pluginKey}'`);
      }
      return pluginDatabaseService(migrationDb).inspectMigrations(pluginId, manifest, packageRoot);
    },

    // -----------------------------------------------------------------------
    // isSupportedApiVersion
    // -----------------------------------------------------------------------

    isSupportedApiVersion(apiVersion: number): boolean {
      return manifestValidator.getSupportedVersions().includes(apiVersion);
    },

    // -----------------------------------------------------------------------
    // cleanupInstallArtifacts
    // -----------------------------------------------------------------------

    async cleanupInstallArtifacts(plugin: PluginRecord, permit: PluginPackageMutationPermit): Promise<void> {
      assertPluginPackageMutationPermit(
        permit,
        plugin.id,
        requiresSharedPluginArtifactCleanup(plugin, localPluginDir),
      );
      if (plugin.packagePath !== null && plugin.packagePath !== undefined) {
        const staged = classifyStagedPackagePath(plugin.packagePath, localPluginDir, plugin.packageName);
        if (staged.underStaging) {
          await removeOwnedStagedArtifact(plugin.packagePath, plugin.packageName, localPluginDir);
          return;
        }
        if (!requiresSharedPluginArtifactCleanup(plugin, localPluginDir)) {
          // Caller-owned local checkouts are unlinked from the registry but
          // their source files and unrelated packages remain untouched.
          return;
        }
      }

      const managedTargets = new Set<string>();
      const managedNodeModulesDir = resolveManagedInstallPackageDir(localPluginDir, plugin.packageName);
      const directManagedDir = path.join(localPluginDir, plugin.packageName);

      managedTargets.add(managedNodeModulesDir);
      if (isPathInsideDir(directManagedDir, localPluginDir)) {
        managedTargets.add(directManagedDir);
      }
      if (plugin.packagePath && isPathInsideDir(plugin.packagePath, localPluginDir)) {
        managedTargets.add(path.resolve(plugin.packagePath));
      }

      const packageJsonPath = path.join(localPluginDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          await runNpm(
            ["uninstall", plugin.packageName, "--prefix", localPluginDir, "--ignore-scripts"],
            { timeout: 120_000 },
          );
        } catch (err) {
          log.warn(
            {
              pluginId: plugin.id,
              pluginKey: plugin.pluginKey,
              packageName: plugin.packageName,
              err: err instanceof Error ? err.message : String(err),
            },
            "plugin-loader: npm uninstall failed during cleanup, falling back to direct removal",
          );
        }
      }

      for (const target of managedTargets) {
        if (!existsSync(target)) continue;
        await rm(target, { recursive: true, force: true });
      }
    },

    requiresSharedPluginArtifactCleanup(plugin: PluginRecord): boolean {
      return requiresSharedPluginArtifactCleanup(plugin, localPluginDir);
    },

    // -----------------------------------------------------------------------
    // getLocalPluginDir
    // -----------------------------------------------------------------------

    getLocalPluginDir(): string {
      return localPluginDir;
    },

    // -----------------------------------------------------------------------
    // hasRuntimeServices
    // -----------------------------------------------------------------------

    hasRuntimeServices(): boolean {
      return runtimeServices !== undefined;
    },

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // loadAll
    // -----------------------------------------------------------------------

    prepareInitialLoad: initialLoadReadiness.prepare,
    waitForInitialLoad: initialLoadReadiness.wait,

    /**
     * loadAll — Loads and activates all plugins that are currently in 'ready' status.
     *
     * This method is typically called during server startup. It fetches all ready
     * plugins from the registry and attempts to activate them in parallel using
     * Promise.allSettled. Failures in individual plugins do not prevent others from loading.
     *
     * @returns A promise that resolves with summary statistics of the load operation.
     */
    async loadAll(): Promise<PluginLoadAllResult> {
      assertRuntimeAllowed("plugin activation");
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadAll: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      const tracksInitialLoad = initialLoadReadiness.begin();

      let readyPlugins: PluginRecord[];
      let activationPromises: Promise<PluginLoadResult>[];
      try {
        log.info("plugin-loader: loading all ready plugins");

        // Fetch all plugins in ready status, ordered by installOrder
        readyPlugins = (await registry.listByStatus("ready")) as PluginRecord[];

        // Publish each target promise before yielding, so a route that arrives
        // during startup can join only its plugin's activation, not its siblings.
        activationPromises = readyPlugins.map(plugin => {
          const activation = activatePlugin(plugin);
          if (tracksInitialLoad) initialLoadReadiness.register(plugin.id, activation);
          return activation;
        });
      } catch (error) {
        if (tracksInitialLoad) initialLoadReadiness.publish();
        throw error;
      }
      if (tracksInitialLoad) initialLoadReadiness.publish();

      if (readyPlugins.length === 0) {
        log.info("plugin-loader: no ready plugins to load");
        return { total: 0, succeeded: 0, failed: 0, results: [] };
      }

      log.info(
        { count: readyPlugins.length },
        "plugin-loader: found ready plugins to load",
      );

      // Load plugins in parallel
      const results = await Promise.allSettled(
        activationPromises
      );

      const loadResults = results.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return {
          plugin: readyPlugins[i]!,
          success: false,
          error: String(r.reason),
          registered: { worker: false, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      });

      const succeeded = loadResults.filter((r) => r.success).length;
      const failed = loadResults.filter((r) => !r.success).length;

      log.info(
        {
          total: readyPlugins.length,
          succeeded,
          failed,
        },
        "plugin-loader: loadAll complete",
      );

      return {
        total: readyPlugins.length,
        succeeded,
        failed,
        results: loadResults,
      };
    },

    // -----------------------------------------------------------------------
    // loadSingle
    // -----------------------------------------------------------------------

    /**
     * loadSingle — Loads and activates a single plugin by its ID.
     *
     * This method retrieves the plugin from the registry, ensures it's in a valid
     * state, and then calls activatePlugin to start its worker and register its
     * capabilities (tools, jobs, etc.).
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns A promise that resolves with the result of the activation.
     */
    async loadSingle(
      pluginId: string,
      options: PluginLoadOptions = {},
    ): Promise<PluginLoadResult> {
      assertRuntimeAllowed("plugin activation");
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadSingle: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      const plugin = (await registry.getById(pluginId)) as PluginRecord | null;
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }

      // If the plugin is in 'installed' status, transition it to 'ready' first.
      // lifecycleManager.load() transitions the status AND activates the plugin
      // via activateReadyPlugin() → loadSingle() (recursive call with 'ready'
      // status) → activatePlugin(). We must NOT call activatePlugin() again here,
      // as that would double-start the worker and duplicate registrations.
      if (plugin.status === "installed") {
        await runtimeServices.lifecycleManager.load(pluginId);
        const updated = (await registry.getById(pluginId)) as PluginRecord | null;
        if (!updated) throw new Error(`Plugin not found after status update: ${pluginId}`);
        return {
          plugin: updated,
          success: true,
          registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      }

      if (plugin.status !== "ready") {
        throw new Error(
          `Cannot load plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'installed' or 'ready' status.`,
        );
      }

      return activatePlugin(plugin, options);
    },

    // -----------------------------------------------------------------------
    // unloadSingle
    // -----------------------------------------------------------------------

    async unloadSingle(pluginId: string, pluginKey: string): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot unloadSingle: no PluginRuntimeServices provided.",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: unloading single plugin",
      );

      const {
        workerManager,
        eventBus,
        jobScheduler,
        toolDispatcher,
      } = runtimeServices;

      // 1. Unregister from job scheduler (cancels in-flight runs)
      try {
        await jobScheduler.unregisterPlugin(pluginId);
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to unregister from job scheduler (best-effort)",
        );
      }

      // 2. Clear event subscriptions
      eventBus.clearPlugin(pluginKey);

      // 3. Unregister agent tools
      toolDispatcher.unregisterPluginTools(pluginKey);

      // 4. Stop the worker process
      try {
        if (workerManager.isRunning(pluginId)) {
          await workerManager.stopWorker(pluginId);
        }
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to stop worker during unload (best-effort)",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: plugin unloaded successfully",
      );
    },

    // -----------------------------------------------------------------------
    // shutdownAll
    // -----------------------------------------------------------------------

    async shutdownAll(): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot shutdownAll: no PluginRuntimeServices provided.",
        );
      }

      log.info("plugin-loader: shutting down all plugins");

      const { workerManager, jobScheduler } = runtimeServices;

      // 1. Stop the job scheduler tick loop
      jobScheduler.stop();

      // 2. Stop all worker processes
      await workerManager.stopAll();

      log.info("plugin-loader: all plugins shut down");
    },
  };

  // -------------------------------------------------------------------------
  // Internal: activatePlugin — shared logic for loadAll and loadSingle
  // -------------------------------------------------------------------------

  /**
   * Activate a single plugin: spawn its worker, register event subscriptions,
   * sync jobs, register tools.
   *
   * This is the core orchestration logic shared by `loadAll()` and `loadSingle()`.
   * Failures are caught and reported in the result; the plugin is marked as
   * `error` in the database when activation fails.
   */
  async function activatePlugin(
    plugin: PluginRecord,
    options: PluginLoadOptions = {},
  ): Promise<PluginLoadResult> {
    const pluginId = plugin.id;
    const pluginKey = plugin.pluginKey;
    let activePlugin = plugin;
    let manifest = activePlugin.manifestJson;

    const registered: PluginLoadResult["registered"] = {
      worker: false,
      eventSubscriptions: 0,
      jobs: 0,
      webhooks: 0,
      tools: 0,
    };

    // Guard: runtime services must exist (callers already checked)
    if (!runtimeServices) {
      return {
        plugin,
        success: false,
        error: "No runtime services available",
        registered,
      };
    }

    const {
      workerManager,
      eventBus,
      jobScheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager,
      buildHostHandlers,
      instanceInfo,
    } = runtimeServices;

    // Bundled plugins may be installed and activated immediately before the
    // startup loadAll() pass. Treat that already-running runtime as a successful
    // activation instead of attempting to register the same worker twice and
    // incorrectly moving a healthy plugin into the error state.
    if (workerManager.isRunning(pluginId)) {
      registered.worker = true;
      log.info(
        { pluginId, pluginKey, version: plugin.version },
        "plugin-loader: plugin worker is already active; skipping duplicate activation",
      );
      return { plugin, success: true, registered };
    }

    try {
      log.info(
        { pluginId, pluginKey, version: plugin.version },
        "plugin-loader: activating plugin",
      );

      // ------------------------------------------------------------------
      // 1. Resolve worker entrypoint
      // ------------------------------------------------------------------
      const packageRoot = resolvePluginPackageRoot(activePlugin, localPluginDir);
      activePlugin = await refreshPluginManifestFromPackage(activePlugin, packageRoot);
      manifest = activePlugin.manifestJson;
      const workerEntrypoint = resolveWorkerEntrypoint(activePlugin, localPluginDir);

      // ------------------------------------------------------------------
      // 2. Apply restricted database migrations before worker startup
      // ------------------------------------------------------------------
      const databaseNamespace = manifest.database
        ? (await pluginDatabaseService(migrationDb).applyMigrations(pluginId, manifest, packageRoot, {
          approvedPlanHash: options.approvedMigrationPlanHash,
        }))?.namespaceName ?? null
        : null;

      // ------------------------------------------------------------------
      // 3. Build host handlers for this plugin
      // ------------------------------------------------------------------
      const hostHandlers = buildHostHandlers(pluginId, manifest);

      // ------------------------------------------------------------------
      // 4. Retrieve plugin config (if any)
      // ------------------------------------------------------------------
      let config: Record<string, unknown> = {};
      try {
        const configRow = await registry.getConfig(pluginId);
        if (configRow && typeof configRow === "object" && "configJson" in configRow) {
          config = (configRow as { configJson: Record<string, unknown> }).configJson ?? {};
        }
      } catch {
        // Config may not exist yet — use empty object
        log.debug({ pluginId }, "plugin-loader: no config found, using empty config");
      }

      // ------------------------------------------------------------------
      // 5. Spawn worker process
      // ------------------------------------------------------------------
      const workerOptions: WorkerStartOptions = {
        entrypointPath: workerEntrypoint,
        manifest,
        config,
        instanceInfo,
        apiVersion: manifest.apiVersion,
        databaseNamespace,
        hostHandlers,
        autoRestart: true,
        env: buildPluginWorkerEnv({ manifest, instanceInfo }),
        // Declared Workspace UI streams belong exclusively to the scoped pool.
        // The package's retained Host worker cannot publish into those tuples.
        onStreamNotification: runtimeServices.streamBus && !manifest.entrypoints.workspaceWorker
          ? (method, params, generation, canPublish) => {
            if (canPublish()) publishPluginStreamNotification(runtimeServices.streamBus!, pluginId, method, params, generation);
          }
          : undefined,
      };

      // Repo-local plugin installs can resolve workspace TS sources at runtime
      // (for example @paperclipai/shared exports). Run those workers through
      // the tsx loader so first-party example plugins work in development.
      if (activePlugin.packagePath && existsSync(DEV_TSX_LOADER_PATH)) {
        workerOptions.execArgv = ["--import", resolveDevTsxLoaderImportSpecifier()];
      }

      await workerManager.startWorker(pluginId, workerOptions);
      registered.worker = true;

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: worker started",
      );

      // ------------------------------------------------------------------
      // 6. Sync job declarations and register with scheduler
      // ------------------------------------------------------------------
      const jobDeclarations = manifest.jobs ?? [];
      if (jobDeclarations.length > 0) {
        await jobStore.syncJobDeclarations(pluginId, jobDeclarations);
        await jobScheduler.registerPlugin(pluginId);
        registered.jobs = jobDeclarations.length;

        log.info(
          { pluginId, pluginKey, jobs: jobDeclarations.length },
          "plugin-loader: job declarations synced and plugin registered with scheduler",
        );
      }

      // ------------------------------------------------------------------
      // 6. Register event subscriptions
      //
      // Note: Event subscriptions are declared at runtime by the plugin
      // worker via the SDK's ctx.events.on() calls. The event bus manages
      // per-plugin subscription scoping. Here we ensure the event bus has
      // a scoped handle ready for this plugin — the actual subscriptions
      // are registered by the host handler layer when the worker calls
      // events.subscribe via RPC.
      //
      // The bus.forPlugin() call creates the scoped handle if needed;
      // any previous subscriptions for this plugin are preserved if the
      // worker is restarting.
      // ------------------------------------------------------------------
      const _scopedBus = eventBus.forPlugin(pluginKey);
      registered.eventSubscriptions = eventBus.subscriptionCount(pluginKey);

      log.debug(
        { pluginId, pluginKey },
        "plugin-loader: event bus scoped handle ready",
      );

      // ------------------------------------------------------------------
      // 7. Register webhook endpoints (manifest-declared)
      //
      // Webhooks are statically declared in the manifest. The actual
      // endpoint routing is handled by the plugin routes module which
      // checks the manifest for declared webhooks. No explicit
      // registration step is needed here — the manifest is persisted
      // in the DB and the route handler reads it at request time.
      //
      // We track the count for the result reporting.
      // ------------------------------------------------------------------
      const webhookDeclarations = manifest.webhooks ?? [];
      registered.webhooks = webhookDeclarations.length;

      if (webhookDeclarations.length > 0) {
        log.info(
          { pluginId, pluginKey, webhooks: webhookDeclarations.length },
          "plugin-loader: webhook endpoints declared in manifest",
        );
      }

      // ------------------------------------------------------------------
      // 8. Register agent tools
      // ------------------------------------------------------------------
      const toolDeclarations = manifest.tools ?? [];
      if (toolDeclarations.length > 0) {
        toolDispatcher.registerPluginTools(pluginKey, manifest, pluginId);
        registered.tools = toolDeclarations.length;

        log.info(
          { pluginId, pluginKey, tools: toolDeclarations.length },
          "plugin-loader: agent tools registered",
        );
      }

      // ------------------------------------------------------------------
      // Done — plugin fully activated
      // ------------------------------------------------------------------
      log.info(
        {
          pluginId,
          pluginKey,
          version: activePlugin.version,
          registered,
        },
        "plugin-loader: plugin activated successfully",
      );

      return { plugin: activePlugin, success: true, registered };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error(
        { pluginId, pluginKey, err: errorMessage },
        "plugin-loader: failed to activate plugin",
      );

      // Mark the plugin as errored in the database so it is not retried
      // automatically on next startup without operator intervention.
      try {
        await lifecycleManager.markError(pluginId, `Activation failed: ${errorMessage}`);
      } catch (markErr) {
        log.error(
          {
            pluginId,
            err: markErr instanceof Error ? markErr.message : String(markErr),
          },
          "plugin-loader: failed to mark plugin as error after activation failure",
        );
      }

      return {
        plugin: activePlugin,
        success: false,
        error: errorMessage,
        registered,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a plugin's worker entrypoint from its manifest
 * and known install locations.
 *
 * The manifest `entrypoints.worker` field is relative to the package root.
 * We check the local plugin directory (where the package was installed) and
 * also the package directory if it was a local-path install.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
function resolveWorkerEntrypoint(
  plugin: PluginRecord & { packagePath?: string | null },
  localPluginDir: string,
): string {
  const manifest = plugin.manifestJson;
  const workerRelPath = manifest.entrypoints.worker;
  const packageDir = resolvePluginPackageRoot(plugin, localPluginDir);
  const entrypoint = path.resolve(packageDir, workerRelPath);

  // An explicit packagePath is authoritative. Never load an older shared
  // package copy when its committed, staged artifact is missing.
  if (isPathInsideDir(entrypoint, packageDir) && existsSync(entrypoint)) return entrypoint;

  // Fallback: try the worker path as-is (absolute or relative to cwd)
  // ONLY if it's already an absolute path and we trust the manifest (which we've already validated)
  if (!plugin.packagePath && path.isAbsolute(workerRelPath) && existsSync(workerRelPath)) {
    return workerRelPath;
  }

  throw new Error(
    `Worker entrypoint not found for plugin "${plugin.pluginKey}". ` +
      `Checked: ${entrypoint}`,
  );
}

/** @internal Resolve a persisted package path without falling back from stale explicit paths. */
export function resolvePluginPackageRoot(
  plugin: PluginRecord & { packagePath?: string | null },
  localPluginDir: string,
): string {
  if (plugin.packagePath !== null && plugin.packagePath !== undefined) {
    if (!path.isAbsolute(plugin.packagePath) || !existsSync(plugin.packagePath)) {
      throw new Error(`Package root not found for plugin "${plugin.pluginKey}"`);
    }
    return path.resolve(plugin.packagePath);
  }

  const packageName = plugin.packageName;
  const packageDir = packageName.startsWith("@")
    ? path.join(localPluginDir, "node_modules", ...packageName.split("/"))
    : path.join(localPluginDir, "node_modules", packageName);
  if (existsSync(packageDir)) return packageDir;

  const directDir = path.join(localPluginDir, packageName);
  if (existsSync(directDir)) return directDir;

  throw new Error(`Package root not found for plugin "${plugin.pluginKey}"`);
}

function resolveManagedInstallPackageDir(localPluginDir: string, packageName: string): string {
  if (packageName.startsWith("@")) {
    return path.join(localPluginDir, "node_modules", ...packageName.split("/"));
  }
  return path.join(localPluginDir, "node_modules", packageName);
}

type StagedArtifactClassification =
  | { underStaging: false }
  | { underStaging: true; root: string | null; npmPackage: boolean };

const UUID_PATH_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function npmPackageSegments(packageName: string): string[] | null {
  const segments = packageName.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  if (packageName.startsWith("@")) return segments.length === 2 ? segments : null;
  return segments.length === 1 ? segments : null;
}

function classifyStagedPackagePath(
  packagePath: string,
  localPluginDir: string,
  packageName: string,
): StagedArtifactClassification {
  if (typeof packagePath !== "string" || !packagePath) return { underStaging: false };
  const resolvedLocalRoot = path.resolve(localPluginDir);
  const resolvedPackagePath = path.resolve(packagePath);
  const relative = path.relative(resolvedLocalRoot, resolvedPackagePath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return { underStaging: false };
  }
  const segments = relative.split(path.sep);
  const isInstallStage = segments[0] === ".install-staging";
  const isUpgradeStage = segments[0] === ".upgrade-staging";
  if (!isInstallStage && !isUpgradeStage) return { underStaging: false };

  const pluginSegments = npmPackageSegments(packageName);
  if (!path.isAbsolute(packagePath) || !pluginSegments) {
    return { underStaging: true, root: null, npmPackage: false };
  }

  if (isInstallStage && UUID_PATH_SEGMENT.test(segments[1] ?? "")) {
    const root = path.join(resolvedLocalRoot, ".install-staging", segments[1]!);
    const expectedNpmLeaf = [".install-staging", segments[1]!, "node_modules", ...pluginSegments];
    if (segments.length === expectedNpmLeaf.length && segments.every((value, index) => value === expectedNpmLeaf[index])) {
      return { underStaging: true, root, npmPackage: true };
    }
  }

  if (isUpgradeStage && UUID_PATH_SEGMENT.test(segments[1] ?? "")
    && UUID_PATH_SEGMENT.test(segments[2] ?? "")) {
    const root = path.join(resolvedLocalRoot, ".upgrade-staging", segments[1]!, segments[2]!);
    if (segments.length === 4 && segments[3] === "package") {
      return { underStaging: true, root, npmPackage: false };
    }
    const expectedNpmLeaf = [".upgrade-staging", segments[1]!, segments[2]!, "node_modules", ...pluginSegments];
    if (segments.length === expectedNpmLeaf.length && segments.every((value, index) => value === expectedNpmLeaf[index])) {
      return { underStaging: true, root, npmPackage: true };
    }
  }

  return { underStaging: true, root: null, npmPackage: false };
}

function isUnderManagedStagingRoot(packagePath: string, localPluginDir: string): boolean {
  if (!path.isAbsolute(packagePath)) return false;
  const relative = path.relative(path.resolve(localPluginDir), path.resolve(packagePath));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return false;
  const firstSegment = relative.split(path.sep)[0];
  return firstSegment === ".install-staging" || firstSegment === ".upgrade-staging";
}

/** @internal Classifies only exact legacy shared npm paths as requiring global mutation fencing. */
export function requiresSharedPluginArtifactCleanup(
  plugin: Pick<PluginRecord, "packageName" | "packagePath">,
  localPluginDir: string,
): boolean {
  if (plugin.packagePath === null) return true;
  if (!plugin.packagePath) return false;
  const staged = classifyStagedPackagePath(plugin.packagePath, localPluginDir, plugin.packageName);
  if (staged.underStaging) return false;
  const resolvedPath = path.resolve(plugin.packagePath);
  return resolvedPath === path.resolve(resolveManagedInstallPackageDir(localPluginDir, plugin.packageName))
    || resolvedPath === path.resolve(localPluginDir, plugin.packageName);
}

function isManagedStagedNpmPackagePath(
  packagePath: string,
  localPluginDir: string,
  packageName: string,
): boolean {
  const staged = classifyStagedPackagePath(packagePath, localPluginDir, packageName);
  return staged.underStaging && staged.root !== null && staged.npmPackage;
}

function isManagedNpmPackagePath(
  packagePath: string,
  localPluginDir: string,
  packageName: string,
): boolean {
  if (isManagedStagedNpmPackagePath(packagePath, localPluginDir, packageName)) return true;
  return path.resolve(packagePath) === path.resolve(resolveManagedInstallPackageDir(localPluginDir, packageName));
}

async function removeOwnedStagedArtifact(
  packagePath: string,
  packageName: string,
  localPluginDir: string,
): Promise<void> {
  const staged = classifyStagedPackagePath(packagePath, localPluginDir, packageName);
  if (!staged.underStaging || !staged.root
    || (!isPathInsideDir(staged.root, path.join(localPluginDir, ".install-staging"))
      && !isPathInsideDir(staged.root, path.join(localPluginDir, ".upgrade-staging")))) {
    throw new Error("Refusing to clean an unrecognized staged plugin artifact");
  }
  await rm(staged.root, { recursive: true, force: true });
}

function isPathInsideDir(candidatePath: string, parentDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentDir);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
