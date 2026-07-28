import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "./plugin.js";

const baseManifest = {
  id: "sps.rooms",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "SPS Rooms",
  description: "Fixture.",
  author: "SPS",
  categories: ["automation"],
  capabilities: ["agents.read"],
  entrypoints: { worker: "./dist/worker.js" },
};

describe("plugin agent platform declaration", () => {
  it("accepts a compatible workplane profile", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      agentPlatform: {
        contractVersion: "1.0",
        kind: "workplane",
        profileKey: "sps-lead-worker",
      },
    }).success).toBe(true);
  });

  it("rejects an incompatible contract and a workplane without a profile key", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      agentPlatform: { contractVersion: "2.0", kind: "workplane" },
    }).success).toBe(false);
  });

  it("accepts an explicit Company activation default", () => {
    expect(pluginManifestV1Schema.safeParse({
      ...baseManifest,
      companyActivation: { defaultEnabled: false },
    }).success).toBe(true);
  });
});
