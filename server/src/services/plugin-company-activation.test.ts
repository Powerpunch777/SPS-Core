import { describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import {
  resolvePluginCompanyActivation,
  setPluginCompanyActivation,
} from "./plugin-company-activation.js";

const plugin = {
  id: "plugin-1",
  pluginKey: "sps.example",
  manifestJson: {
    id: "sps.example",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Example",
    description: "Fixture.",
    author: "SPS",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "./dist/worker.js" },
  },
} as Pick<PluginRecord, "id" | "pluginKey" | "manifestJson">;

describe("plugin Company activation", () => {
  it("keeps legacy plugins enabled when no Company override exists", async () => {
    const registry = { getCompanySettings: vi.fn().mockResolvedValue(null) };

    await expect(resolvePluginCompanyActivation(registry as never, plugin, "company-1")).resolves.toMatchObject({
      enabled: true,
      source: "default",
      defaultEnabled: true,
    });
  });

  it("uses a declared disabled default until a Company opts in", async () => {
    const registry = { getCompanySettings: vi.fn().mockResolvedValue(null) };
    const optInPlugin = {
      ...plugin,
      manifestJson: { ...plugin.manifestJson, companyActivation: { defaultEnabled: false } },
    } as Pick<PluginRecord, "id" | "pluginKey" | "manifestJson">;

    await expect(resolvePluginCompanyActivation(registry as never, optInPlugin, "company-1")).resolves.toMatchObject({
      enabled: false,
      source: "default",
      defaultEnabled: false,
    });
  });

  it("preserves Company settings when changing activation", async () => {
    const registry = {
      getCompanySettings: vi.fn().mockResolvedValue({ enabled: false, settingsJson: { workspace: "C:/SPS" }, lastError: null }),
      upsertCompanySettings: vi.fn().mockResolvedValue({}),
    };

    await expect(setPluginCompanyActivation(registry as never, plugin, "company-1", true)).resolves.toMatchObject({
      enabled: true,
      source: "explicit",
    });
    expect(registry.upsertCompanySettings).toHaveBeenCalledWith("plugin-1", "company-1", {
      enabled: true,
      settingsJson: { workspace: "C:/SPS" },
      lastError: null,
    });
  });
});
