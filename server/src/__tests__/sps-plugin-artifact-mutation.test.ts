import { describe, expect, it, vi } from "vitest";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { withSpsPluginArtifactMutation } from "../services/sps-plugin-artifact-mutation.js";

describe("artifact mutation uses existing private activity admission", () => {
  it("returns a fixed conflict without invoking a mutation under maintenance", async () => {
    const maintenance = createSpsPluginArtifactMaintenance(), action = vi.fn(async () => {});
    await maintenance.withMaintenance(async () => {
      await expect(withSpsPluginArtifactMutation(maintenance, action)).rejects.toMatchObject({
        status: 409, details: { code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" },
      });
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("holds activity until the actual awaited action settles without draining it", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const operation = withSpsPluginArtifactMutation(maintenance, async () => { await pending; return "complete"; });
    try {
      await expect(maintenance.withMaintenance(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    } finally { release(); }
    expect(await operation).toBe("complete");
    await maintenance.withMaintenance(async () => {});
  });

  it("preserves unrelated failures and releases nested activity on rejection", async () => {
    const maintenance = createSpsPluginArtifactMaintenance(), failure = new Error("Original SQL failure");
    await expect(withSpsPluginArtifactMutation(maintenance, () => withSpsPluginArtifactMutation(maintenance,
      async () => { throw failure; }))).rejects.toBe(failure);
    await maintenance.withMaintenance(async () => {});
  });

  it("keeps legacy caller behavior without claiming a coordinated scope", async () => {
    const result = Object.freeze({ legacy: true });
    expect(await withSpsPluginArtifactMutation(undefined, async () => result)).toBe(result);
  });
});
