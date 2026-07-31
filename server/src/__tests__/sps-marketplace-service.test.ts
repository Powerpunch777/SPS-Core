import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMarketplacePlugin,
  marketplaceToolDeclarations,
  marketplaceToolHandlers,
  searchMarketplacePlugins,
} from "../services/sps-marketplace.js";

const created: string[] = [];

async function useCatalog(value: unknown) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sps-marketplace-"));
  const filePath = path.join(directory, "catalog.json");
  await writeFile(filePath, JSON.stringify(value), "utf8");
  process.env.SPS_MARKETPLACE_CATALOG_PATH = filePath;
  created.push(directory);
}

afterEach(async () => {
  delete process.env.SPS_MARKETPLACE_CATALOG_PATH;
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SPS Marketplace service", () => {
  it("returns the standardized bounded public list shape", async () => {
    await useCatalog({
      schemaVersion: 1,
      source: { id: "io.sps.official", displayName: "SPS Marketplace" },
      refreshedAt: "2026-07-31T00:00:00.000Z",
      releases: [
        {
          pluginId: "zeta",
          version: "1.0.0",
          catalog: { displayName: "Zeta", summary: "A game workflow", category: "games" },
          capabilities: ["art", "qa"],
          publisherId: "sps",
          publisherProfile: { displayName: "SPS" },
          compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0", localPath: "must-not-leak" },
          artifactUrl: "https://example.invalid/artifact.zip",
          installCommand: "npm install zeta",
        },
        {
          pluginId: "alpha",
          version: "2.0.0",
          catalog: { displayName: "Alpha", summary: "A web workflow", categories: ["web"] },
          capabilities: ["qa"],
          publisherProfile: { displayName: "Community" },
          compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0" },
        },
      ],
    });

    const result = await searchMarketplacePlugins({ capability: "qa", limit: 1 });
    expect(result).toEqual({
      plugins: [{
        pluginId: "alpha",
        displayName: "Alpha",
        version: "2.0.0",
        summary: "A web workflow",
        categories: ["web"],
        capabilities: ["qa"],
        publisher: "Community",
        trust: "official",
        compatibility: { sps: ">=0.4.0", pluginApi: 1, extensionProfile: "2.0" },
      }],
      total: 2,
      source: { id: "io.sps.official", displayName: "SPS Marketplace" },
      refreshedAt: "2026-07-31T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/artifact|localPath|installCommand|release|mutation|lifecycle/i);
  });

  it("returns a wrapped detail and rejects unknown plugins", async () => {
    await useCatalog({
      schemaVersion: 1,
      releases: [{
        pluginId: "plugin.one",
        version: "1.2.3",
        catalog: { displayName: "Plugin One", summary: "Useful plugin", description: "Public description", categories: ["tools"], adapterRequirements: ["codex"], documentationUrl: "https://example.invalid/docs" },
        capabilities: ["search"],
        publisherProfile: { displayName: "Author" },
        permissions: ["workspace.read"],
      }],
    });
    expect(await getMarketplacePlugin("plugin.one")).toEqual({
      plugin: expect.objectContaining({ pluginId: "plugin.one", displayName: "Plugin One" }),
    });
    await expect(getMarketplacePlugin("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("fails closed for missing or unsupported catalog snapshots", async () => {
    await useCatalog({ schemaVersion: 2, releases: [] });
    await expect(searchMarketplacePlugins()).rejects.toMatchObject({ status: 503 });
  });

  it("exports only the two read-only assistant tools", () => {
    expect(marketplaceToolDeclarations.map((tool) => tool.name)).toEqual([
      "search_marketplace_plugins",
      "get_marketplace_plugin",
    ]);
    expect(Object.keys(marketplaceToolHandlers)).toEqual([
      "search_marketplace_plugins",
      "get_marketplace_plugin",
    ]);
    expect(marketplaceToolDeclarations.every((tool) => tool.readOnly)).toBe(true);
  });
});
