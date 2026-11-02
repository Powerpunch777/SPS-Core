import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  listByStatus: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { pluginLoader } from "./plugin-loader.js";

describe("plugin loader initial load readiness integration", () => {
  beforeEach(() => {
    registry.listByStatus.mockReset();
  });

  it("publishes the delayed initial ready list before releasing target waiters", async () => {
    let publishReadyPlugins!: (plugins: unknown[]) => void;
    registry.listByStatus.mockImplementation(() => new Promise(resolve => {
      publishReadyPlugins = resolve;
    }));
    const loader = pluginLoader({} as never, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, { instanceInfo: { hostVersion: "test" } } as never);

    const releaseStartupPreparation = loader.prepareInitialLoad!();
    let targetWaitFinished = false;
    const targetWait = loader.waitForInitialLoad!("new-install").then(() => {
      targetWaitFinished = true;
    });
    await Promise.resolve();
    expect(targetWaitFinished).toBe(false);

    const loading = loader.loadAll();
    publishReadyPlugins([]);
    await loading;
    await targetWait;
    releaseStartupPreparation();
    expect(targetWaitFinished).toBe(true);
  });

  it("releases waiters when the initial ready-list query fails", async () => {
    registry.listByStatus.mockRejectedValue(new Error("private database detail"));
    const loader = pluginLoader({} as never, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, { instanceInfo: { hostVersion: "test" } } as never);

    const loading = loader.loadAll();
    const targetWait = loader.waitForInitialLoad!("plugin-a");
    await expect(loading).rejects.toThrow("private database detail");
    await expect(targetWait).resolves.toBeUndefined();
  });
});
