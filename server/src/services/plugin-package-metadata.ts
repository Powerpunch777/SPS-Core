/**
 * Resolves the SPS plugin package entrypoint metadata.
 *
 * `spsPlugin` is the public SPS contract. `paperclipPlugin` is read only as a
 * compatibility alias while existing packages migrate. Packages that declare
 * both keys must declare the same metadata so the host never has to guess
 * which entrypoint it should execute.
 */

export const SPS_PLUGIN_PACKAGE_KEY = "spsPlugin";
export const LEGACY_PLUGIN_PACKAGE_KEY = "paperclipPlugin";

export type SpsPluginPackageEntrypoints = Record<string, unknown>;

export type ResolvedSpsPluginPackageMetadata = {
  entrypoints: SpsPluginPackageEntrypoints;
  source: "spsPlugin" | "paperclipPlugin";
  usesLegacyCompatibilityKey: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function readMetadata(
  packageJson: Record<string, unknown>,
  key: typeof SPS_PLUGIN_PACKAGE_KEY | typeof LEGACY_PLUGIN_PACKAGE_KEY,
): SpsPluginPackageEntrypoints | undefined {
  if (!(key in packageJson)) return undefined;

  const metadata = packageJson[key];
  if (!isRecord(metadata)) {
    const displayKey = key === LEGACY_PLUGIN_PACKAGE_KEY
      ? `legacy compatibility key \"${LEGACY_PLUGIN_PACKAGE_KEY}\"`
      : `SPS key \"${SPS_PLUGIN_PACKAGE_KEY}\"`;
    throw new Error(`Plugin package metadata at ${displayKey} must be an object.`);
  }

  return metadata;
}

/**
 * Returns the single unambiguous package entrypoint declaration, if present.
 *
 * This function intentionally validates the entire metadata object instead of
 * comparing only known entrypoints. That keeps future SPS metadata additions
 * deterministic across hosts during the compatibility period.
 */
export function resolveSpsPluginPackageMetadata(
  packageJson: Record<string, unknown>,
): ResolvedSpsPluginPackageMetadata | null {
  const spsPlugin = readMetadata(packageJson, SPS_PLUGIN_PACKAGE_KEY);
  const legacyPlugin = readMetadata(packageJson, LEGACY_PLUGIN_PACKAGE_KEY);

  if (spsPlugin && legacyPlugin && canonicalJson(spsPlugin) !== canonicalJson(legacyPlugin)) {
    throw new Error(
      `Plugin package metadata is ambiguous: \"${SPS_PLUGIN_PACKAGE_KEY}\" and legacy compatibility key ` +
        `\"${LEGACY_PLUGIN_PACKAGE_KEY}\" must be structurally identical.`,
    );
  }

  if (spsPlugin) {
    return {
      entrypoints: spsPlugin,
      source: SPS_PLUGIN_PACKAGE_KEY,
      usesLegacyCompatibilityKey: false,
    };
  }

  if (legacyPlugin) {
    return {
      entrypoints: legacyPlugin,
      source: LEGACY_PLUGIN_PACKAGE_KEY,
      usesLegacyCompatibilityKey: true,
    };
  }

  return null;
}

export function hasSpsPluginPackageMetadata(packageJson: Record<string, unknown>): boolean {
  return resolveSpsPluginPackageMetadata(packageJson) !== null;
}

export function declaredSpsPluginEntrypoint(
  packageJson: Record<string, unknown>,
  key: "manifest" | "worker" | "ui",
): string | null {
  const metadata = resolveSpsPluginPackageMetadata(packageJson);
  const value = metadata?.entrypoints[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
