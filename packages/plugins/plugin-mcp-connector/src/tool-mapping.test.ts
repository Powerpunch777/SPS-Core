import { describe, expect, it } from "vitest";
import { defaultInputSchema, mapAllowedRemoteTools } from "./tool-mapping.js";

describe("Remote MCP tool mapping", () => {
  it("exposes only exact allowlisted remote tools with SPS-safe names", () => {
    expect(mapAllowedRemoteTools([
      { name: "search projects", inputSchema: { type: "object" } },
      { name: "delete_all" },
    ], ["search projects"])).toEqual([
      expect.objectContaining({ name: "search projects", spsToolName: "mcp_search_projects" }),
    ]);
  });

  it("keeps colliding normalized names distinct", () => {
    const mapped = mapAllowedRemoteTools([
      { name: "search projects" },
      { name: "search/projects" },
    ], ["search projects", "search/projects"]);
    expect(new Set(mapped.map((tool) => tool.spsToolName)).size).toBe(2);
  });

  it("provides an object schema when a remote server omits one", () => {
    expect(defaultInputSchema(undefined)).toEqual({ type: "object", properties: {} });
  });
});
