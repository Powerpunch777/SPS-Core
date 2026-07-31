import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  executeMarketplaceTool,
  marketplaceToolBridge,
  type MarketplaceToolContext,
} from "../services/sps-marketplace-tool-bridge.js";

const context: MarketplaceToolContext = {
  companyId: "company-1",
  runId: "run-1",
  agentId: "agent-1",
  userId: "user-1",
};

async function withCatalog() {
  const path = join(tmpdir(), `sps-marketplace-bridge-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    source: { id: "io.sps.official", displayName: "SPS Marketplace" },
    refreshedAt: "2026-07-31T00:00:00.000Z",
    releases: [{
      pluginId: "plugin.one",
      displayName: "Plugin One",
      version: "1.0.0",
      summary: "A public plugin",
      description: "Public details",
      capabilities: ["qa"],
      permissions: ["secret.permission"],
      documentationUrl: "https://example.com/docs",
    }],
  }));
  const previous = process.env.SPS_MARKETPLACE_CATALOG_PATH;
  process.env.SPS_MARKETPLACE_CATALOG_PATH = path;
  return () => {
    if (previous === undefined) delete process.env.SPS_MARKETPLACE_CATALOG_PATH;
    else process.env.SPS_MARKETPLACE_CATALOG_PATH = previous;
  };
}

describe("SPS Marketplace Tool Bridge", () => {
  it("exposes and executes exactly the two read-only marketplace tools", async () => {
    const restore = await withCatalog();
    try {
      expect(marketplaceToolBridge.declarations.map((tool) => tool.name)).toEqual([
        "search_marketplace_plugins",
        "get_marketplace_plugin",
      ]);
      expect(marketplaceToolBridge.declarations.every((tool) => tool.readOnly)).toBe(true);
      await expect(executeMarketplaceTool("search_marketplace_plugins", {}, context))
        .resolves.toMatchObject({ total: 1 });
      await expect(executeMarketplaceTool("get_marketplace_plugin", { pluginId: "plugin.one" }, context))
        .resolves.toMatchObject({ plugin: { pluginId: "plugin.one" } });
    } finally {
      restore();
    }
  });

  it.each(["companyId", "runId", "agentId", "userId"] as const)(
    "requires %s in the execution context",
    async (missing) => {
      await expect(executeMarketplaceTool("search_marketplace_plugins", {}, { ...context, [missing]: "" }))
        .rejects.toMatchObject({ status: 400 });
    },
  );

  it("rejects unknown tools and invalid input before dispatch", async () => {
    const handler = vi.spyOn((await import("../services/sps-marketplace.js")), "searchMarketplacePlugins");
    await expect(executeMarketplaceTool("delete_marketplace_plugin", {}, context)).rejects.toMatchObject({ status: 400 });
    await expect(executeMarketplaceTool("search_marketplace_plugins", { secret: "do-not-echo" }, context))
      .rejects.toMatchObject({ status: 400 });
    expect(handler).not.toHaveBeenCalled();
    handler.mockRestore();
  });

  it("does not expose bridge context or sensitive plugin fields", async () => {
    const restore = await withCatalog();
    try {
      const result = await executeMarketplaceTool("search_marketplace_plugins", {}, context);
      expect(JSON.stringify(result)).not.toContain("company-1");
      expect(JSON.stringify(result)).not.toContain("secret.permission");
      const detail = await executeMarketplaceTool("get_marketplace_plugin", { pluginId: "plugin.one" }, context);
      expect(detail).not.toHaveProperty("companyId");
      expect(detail).not.toHaveProperty("runId");
      expect(detail).not.toHaveProperty("agentId");
      expect(detail).not.toHaveProperty("userId");
    } finally {
      restore();
    }
  });
});
