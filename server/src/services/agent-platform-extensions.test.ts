import { describe, expect, it } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { listReadyAgentPlatformExtensions } from "./agent-platform-extensions.js";

function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "plugin-id",
    pluginKey: "sps.rooms",
    packageName: "sps-rooms",
    version: "1.0.0",
    apiVersion: 1,
    categories: ["automation"],
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    manifestJson: {
      id: "sps.rooms",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "SPS Rooms",
      description: "Fixture.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["agents.read"],
      entrypoints: { worker: "./dist/worker.js" },
      agentPlatform: {
        contractVersion: "1.0",
        kind: "workplane",
        profileKey: "sps-lead-worker",
      },
    },
    ...overrides,
  };
}

describe("listReadyAgentPlatformExtensions", () => {
  it("lists compatible ready extensions without exposing plugin configuration", () => {
    const extensions = listReadyAgentPlatformExtensions([
      plugin({ status: "installed" }),
      plugin(),
      plugin({
        id: "incompatible",
        pluginKey: "other.rooms",
        manifestJson: {
          ...plugin().manifestJson,
          id: "other.rooms",
          agentPlatform: { contractVersion: "2.0", kind: "workplane", profileKey: "other" },
        },
      }),
    ]);

    expect(extensions).toEqual([
      expect.objectContaining({
        pluginKey: "sps.rooms",
        kind: "workplane",
        profileKey: "sps-lead-worker",
      }),
    ]);
  });
});
