import { describe, expect, it, vi } from "vitest";
import { createSpsPluginArtifactMaintenance, SpsPluginArtifactMaintenanceBusyError } from "../services/sps-plugin-artifact-maintenance.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const busy = { code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" };

describe("non-draining private plugin artifact maintenance", () => {
  it("counts parallel activities immediately and rejects maintenance without interrupting either", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    const first = deferred(), second = deferred();
    let completed = 0;
    const a = gate.withActivity(async () => { await first.promise; completed++; });
    const b = gate.withActivity(async () => { await second.promise; completed++; });
    const inspection = vi.fn(async () => {});
    try {
      await expect(gate.withMaintenance(inspection)).rejects.toMatchObject(busy);
      expect(completed).toBe(0);
      first.resolve(); await a;
      await expect(gate.withMaintenance(inspection)).rejects.toMatchObject(busy);
      second.resolve(); await b;
      await gate.withMaintenance(inspection);
      expect(inspection).toHaveBeenCalledOnce();
    } finally { first.resolve(); second.resolve(); await Promise.all([a, b]); }
  });

  it("denies activities, synchronous admission and maintenance reentry for its exact dynamic lifetime", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    const release = deferred();
    const action = vi.fn(async () => {});
    const holding = gate.withMaintenance(async () => { await release.promise; });
    try {
      expect(() => gate.assertAdmissionAllowed()).toThrowError(expect.objectContaining(busy));
      await expect(gate.withActivity(action)).rejects.toMatchObject(busy);
      await expect(gate.withMaintenance(action)).rejects.toMatchObject(busy);
      expect(action).not.toHaveBeenCalled();
    } finally { release.resolve(); await holding; }
    gate.assertAdmissionAllowed();
    await gate.withActivity(action);
    await gate.withMaintenance(action);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("counts detached nested activities after their parent has returned", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    const release = deferred();
    let nested!: Promise<void>;
    await gate.withActivity(async () => { nested = gate.withActivity(async () => { await release.promise; }); });
    try { await expect(gate.withMaintenance(async () => {})).rejects.toMatchObject(busy); }
    finally { release.resolve(); await nested; }
    await gate.withMaintenance(async () => {});
  });

  it("rejects upgrading an admitted activity to maintenance instead of deadlocking", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    await gate.withActivity(async () => {
      await gate.withActivity(async () => {});
      await expect(gate.withMaintenance(async () => {})).rejects.toMatchObject(busy);
    });
    await gate.withMaintenance(async () => {});
  });

  it("preserves original synchronous and asynchronous failures and releases both lanes", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    const failure = new Error("original controlled failure");
    for (const call of [gate.withActivity, gate.withMaintenance]) {
      await expect(call(() => { throw failure; })).rejects.toBe(failure);
      await expect(call(async () => { await Promise.resolve(); throw failure; })).rejects.toBe(failure);
      await gate.withActivity(async () => {});
      await gate.withMaintenance(async () => {});
    }
  });

  it("does not leak state between independent Hosts or accept missing actions", async () => {
    const first = createSpsPluginArtifactMaintenance(), second = createSpsPluginArtifactMaintenance();
    await first.withMaintenance(async () => {
      await second.withActivity(async () => {});
      await second.withMaintenance(async () => {});
    });
    for (const call of [first.withActivity, first.withMaintenance]) {
      await expect(call(null as never)).rejects.toBeInstanceOf(TypeError);
      await first.withMaintenance(async () => {});
    }
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("returns the exact action value and uses a fixed bounded busy error", async () => {
    const gate = createSpsPluginArtifactMaintenance();
    const result = Object.freeze({ retained: true });
    expect(await gate.withActivity(async () => result)).toBe(result);
    expect(await gate.withMaintenance(async () => result)).toBe(result);
    await gate.withMaintenance(async () => {
      let observed: unknown;
      try { gate.assertAdmissionAllowed(); } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(SpsPluginArtifactMaintenanceBusyError);
      expect(observed).toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY",
        message: "Plugin artifact maintenance is busy. Wait for the current operation, refresh and retry." });
    });
  });
});
