import { describe, expect, it, vi } from "vitest";
import { pluginLoader } from "../services/plugin-loader.js";

describe("plugin loader Workspace catalog mutation fence", () => {
  it("fails closed before fetching or touching the registry when Worker drain fails", async () => {
    const stopFailure = new Error("workspace workers are not confirmed closed");
    const withCatalogMutation = vi.fn(async (_action: () => Promise<unknown>) => { throw stopFailure; });
    const loader = pluginLoader({} as any, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, {
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
      workspaceRuntime: { withCatalogMutation },
    } as any);

    await expect(loader.installPlugin({ localPath: "C:/plugin-source" })).rejects.toBe(stopFailure);
    expect(withCatalogMutation).toHaveBeenCalledOnce();
    expect(withCatalogMutation.mock.calls[0]?.[0]).toEqual(expect.any(Function));
  });
});
