import { readFile } from "node:fs/promises";
import { HttpError, notFound } from "../errors.js";

const CATALOG_SCHEMA_VERSION = 1 as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type MarketplaceTrust = "official" | "verified" | "local";

export interface MarketplacePluginSummary {
  pluginId: string;
  displayName: string;
  version: string;
  summary: string;
  categories: string[];
  capabilities: string[];
  publisher: string;
  trust: MarketplaceTrust;
  compatibility: Record<string, string>;
}

export interface MarketplacePluginDetail extends MarketplacePluginSummary {
  description: string | null;
  permissions: string[];
  adapterRequirements: string[];
  documentationUrl: string | null;
}

export interface MarketplaceSearchQuery {
  q?: string;
  category?: string;
  capability?: string;
  limit?: number;
}

export interface MarketplaceSearchResult {
  plugins: MarketplacePluginSummary[];
  total: number;
  source: { id: string; displayName: string } | null;
  refreshedAt: string | null;
}

interface RawCatalog {
  schemaVersion?: unknown;
  plugins?: unknown;
  source?: unknown;
  refreshedAt?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringList(value: unknown, max = 32): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return Array.from(new Set(values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max)));
}

function publicUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function trustValue(value: unknown): MarketplaceTrust {
  return value === "official" || value === "verified" || value === "local" ? value : "local";
}

function compatibilityValue(value: unknown): Record<string, string> {
  const source = record(value);
  const result: Record<string, string> = {};
  for (const key of ["spsCore", "desktop", "node", "os"]) {
    const item = stringValue(source[key]);
    if (item) result[key] = item;
  }
  return result;
}

function normalizePlugin(value: unknown): MarketplacePluginDetail | null {
  const source = record(value);
  const id = stringValue(source.id);
  const name = stringValue(source.displayName, stringValue(source.name));
  const version = stringValue(source.version);
  const summary = stringValue(source.summary, stringValue(source.description));
  if (!id || !name || !version || !summary) return null;
  return {
    pluginId: id,
    displayName: name,
    version,
    summary,
    description: stringValue(source.description) || null,
    categories: stringList(source.categories ?? source.category),
    capabilities: stringList(source.capabilities),
    publisher: stringValue(source.publisher, "Unknown publisher"),
    trust: trustValue(source.trust),
    compatibility: compatibilityValue(source.compatibility),
    permissions: stringList(source.permissions),
    adapterRequirements: stringList(source.adapterRequirements),
    documentationUrl: publicUrl(source.documentationUrl),
  };
}

function comparePlugins(left: MarketplacePluginDetail, right: MarketplacePluginDetail): number {
  return left.displayName.localeCompare(right.displayName) || left.pluginId.localeCompare(right.pluginId) || left.version.localeCompare(right.version);
}

function searchableText(plugin: MarketplacePluginDetail): string {
  return [
    plugin.pluginId,
    plugin.displayName,
    plugin.summary,
    plugin.description ?? "",
    ...plugin.categories,
    plugin.publisher,
    ...plugin.capabilities,
  ].join(" ").toLocaleLowerCase();
}

function catalogPath(): string {
  const value = process.env.SPS_MARKETPLACE_CATALOG_PATH?.trim();
  if (!value) throw new HttpError(503, "Marketplace catalog is not configured");
  return value;
}

interface LoadedCatalog {
  plugins: MarketplacePluginDetail[];
  source: { id: string; displayName: string } | null;
  refreshedAt: string | null;
}

async function loadCatalog(): Promise<LoadedCatalog> {
  let parsed: RawCatalog;
  try {
    parsed = JSON.parse(await readFile(catalogPath(), "utf8")) as RawCatalog;
  } catch {
    throw new HttpError(503, "Marketplace catalog is unavailable");
  }
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION || !Array.isArray(parsed.plugins)) {
    throw new HttpError(503, "Marketplace catalog has an unsupported schema");
  }
  const plugins = parsed.plugins
    .map(normalizePlugin)
    .filter((plugin): plugin is MarketplacePluginDetail => plugin !== null)
    .sort(comparePlugins);
  const sourceRecord = record(parsed.source);
  const sourceId = stringValue(sourceRecord.id);
  const sourceDisplayName = stringValue(sourceRecord.displayName);
  const refreshedAt = stringValue(parsed.refreshedAt) || null;
  return {
    plugins,
    source: sourceId && sourceDisplayName ? { id: sourceId, displayName: sourceDisplayName } : null,
    refreshedAt,
  };
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

export async function searchMarketplacePlugins(query: MarketplaceSearchQuery = {}): Promise<MarketplaceSearchResult> {
  const q = query.q?.trim().toLocaleLowerCase() ?? "";
  const category = query.category?.trim().toLocaleLowerCase() ?? "";
  const capability = query.capability?.trim().toLocaleLowerCase() ?? "";
  const limit = normalizedLimit(query.limit);
  const catalog = await loadCatalog();
  const plugins = catalog.plugins.filter((plugin) =>
    (!q || searchableText(plugin).includes(q))
    && (!category || plugin.categories.some((item) => item.toLocaleLowerCase() === category))
    && (!capability || plugin.capabilities.some((item) => item.toLocaleLowerCase() === capability)),
  );
  return {
    plugins: plugins.slice(0, limit).map(toSummary),
    total: plugins.length,
    source: catalog.source,
    refreshedAt: catalog.refreshedAt,
  };
}

export async function getMarketplacePlugin(pluginId: string): Promise<{ plugin: MarketplacePluginDetail }> {
  const normalizedId = pluginId.trim();
  const plugin = (await loadCatalog()).plugins.find((item) => item.pluginId === normalizedId);
  if (!plugin) throw notFound("Marketplace plugin not found");
  return { plugin };
}

function toSummary(plugin: MarketplacePluginDetail): MarketplacePluginSummary {
  const { description: _description, permissions: _permissions, adapterRequirements: _adapterRequirements,
    documentationUrl: _documentationUrl, ...summary } = plugin;
  return summary;
}

export interface MarketplaceToolDeclaration {
  name: "search_marketplace_plugins" | "get_marketplace_plugin";
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: true;
}

export const marketplaceToolDeclarations: readonly MarketplaceToolDeclaration[] = [
  {
    name: "search_marketplace_plugins",
    description: "Search the read-only SPS Marketplace catalog.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        category: { type: "string" },
        capability: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      },
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: "get_marketplace_plugin",
    description: "Read one Marketplace plugin's public metadata.",
    inputSchema: {
      type: "object",
      properties: { pluginId: { type: "string", minLength: 1 } },
      required: ["pluginId"],
      additionalProperties: false,
    },
    readOnly: true,
  },
] as const;

export const marketplaceToolHandlers = {
  search_marketplace_plugins: searchMarketplacePlugins,
  get_marketplace_plugin: getMarketplacePlugin,
} as const;
