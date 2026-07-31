import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { analyzePluginDependencies, comparePluginDependencyVersions, isPluginDependencyAvailable } from "../services/plugin-dependencies.js";

function plugin(id: string, version = "1.0.0", extra: Partial<PaperclipPluginManifestV1> = {}, active = true, available = true) {
  return {
    id: `${id}-record`, version, active, available,
    manifest: {
      id, apiVersion: 1, version, displayName: id, description: id, author: "SPS", categories: ["automation"], capabilities: [], entrypoints: { worker: "./worker.js" }, ...extra,
    } as PaperclipPluginManifestV1,
  };
}

describe("plugin dependency analysis", () => {
  it("uses precision-safe SemVer ordering", () => {
    expect(comparePluginDependencyVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
    expect(comparePluginDependencyVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBeGreaterThan(0);
  });

  it("reports deterministic missing, incompatible, conflict, and cycle blockers", () => {
    const report = analyzePluginDependencies([
      plugin("sps.missing", "1.0.0", { requiredDependencies: [{ id: "sps.absent" }] }),
      plugin("sps.versioned", "1.0.0", { requiredDependencies: [{ id: "sps.base", minVersion: "2.0.0" }] }),
      plugin("sps.base", "1.0.0"),
      plugin("sps.conflict", "1.0.0", { conflicts: [{ id: "sps.base" }] }),
      plugin("sps.cycle-a", "1.0.0", { requiredDependencies: [{ id: "sps.cycle-b" }] }),
      plugin("sps.cycle-b", "1.0.0", { requiredDependencies: [{ id: "sps.cycle-a" }] }),
    ]);
    expect(report.status).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["MISSING_REQUIRED", "REQUIRED_VERSION_INCOMPATIBLE", "CONFLICT", "CYCLE"]));
    expect(report.blockedPluginIds).toEqual(expect.arrayContaining(["sps.missing", "sps.versioned", "sps.conflict", "sps.cycle-a", "sps.cycle-b"]));
  });

  it("does not block a target activation because an unrelated active plugin is broken", () => {
    const report = analyzePluginDependencies([
      plugin("sps.broken", "1.0.0", { requiredDependencies: [{ id: "sps.absent" }] }),
      plugin("sps.target", "1.0.0", {}, false),
    ], { action: "enable", pluginId: "sps.target" });
    expect(report.status).toBe("blocked");
    expect(isPluginDependencyAvailable(report, "sps.target")).toBe(true);
    expect(isPluginDependencyAvailable(report, "sps.broken")).toBe(false);
  });

  it("blocks the target when an already-active plugin declares a conflict with it", () => {
    const report = analyzePluginDependencies([
      plugin("sps.declarer", "1.0.0", { conflicts: [{ id: "sps.target" }] }),
      plugin("sps.target", "1.0.0", {}, false),
    ], { action: "enable", pluginId: "sps.target" });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "CONFLICT", pluginId: "sps.declarer", conflictPluginId: "sps.target" }));
    expect(isPluginDependencyAvailable(report, "sps.target")).toBe(false);
  });

  it("does not let a non-ready Host package satisfy a target enable or dependent", () => {
    const report = analyzePluginDependencies([
      plugin("sps.consumer", "1.0.0", { requiredDependencies: [{ id: "sps.pending" }] }),
      plugin("sps.pending", "1.0.0", {}, false, false),
    ], { action: "enable", pluginId: "sps.pending" });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "MISSING_REQUIRED", pluginId: "sps.consumer", dependencyId: "sps.pending" }));
  });

  it("reports but never cascades disable/delete impacts", () => {
    const report = analyzePluginDependencies([
      plugin("sps.provider"),
      plugin("sps.consumer", "1.0.0", { requiredDependencies: [{ id: "sps.provider" }] }),
    ], { action: "disable", pluginId: "sps.provider" });
    expect(report.impact).toMatchObject({ action: "disable", pluginId: "sps.provider", affectedPluginIds: ["sps.consumer"] });
  });
});
