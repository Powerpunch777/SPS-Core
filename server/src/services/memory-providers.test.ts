import { describe, expect, it } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import {
  isCoreManagedMemoryLifecycleSubscription,
  isDeclaredMemoryProviderTool,
  listReadyMemoryProviders,
} from "./memory-providers.js";

function plugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "plugin-id",
    pluginKey: "sps.default-memory",
    packageName: "sps-default-memory",
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
      id: "sps.default-memory",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "SPS Default Memory",
      description: "Fixture.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["memory.providers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      memoryProvider: {
        providerKey: "sps-default",
        displayName: "SPS Default Memory",
        scopes: ["company", "project", "room"],
        lifecycleEvents: ["room.checkpoint"],
        defaultForNewCompanies: true,
      },
    },
    ...overrides,
  };
}

describe("listReadyMemoryProviders", () => {
  it("exposes only ready providers and favors the first declared provider key", () => {
    const providers = listReadyMemoryProviders([
      plugin({ status: "installed" }),
      plugin(),
      plugin({ id: "duplicate", pluginKey: "other.memory" }),
    ]);

    expect(providers).toEqual([
      expect.objectContaining({
        pluginId: "plugin-id",
        providerKey: "sps-default",
        defaultForNewCompanies: true,
      }),
    ]);
  });

  it("reserves declared memory lifecycle subscriptions for the Core selector", () => {
    const manifest = plugin().manifestJson;
    expect(isCoreManagedMemoryLifecycleSubscription(manifest, "room.checkpoint")).toBe(true);
    expect(isCoreManagedMemoryLifecycleSubscription(manifest, "task.completed")).toBe(false);
  });

  it("gates only the tools declared by the memory provider", () => {
    const [provider] = listReadyMemoryProviders([plugin({
      manifestJson: {
        ...plugin().manifestJson,
        tools: [
          { name: "recall", displayName: "Recall", description: "Recall", parametersSchema: {} },
          { name: "unrelated", displayName: "Other", description: "Other", parametersSchema: {} },
        ],
        memoryProvider: {
          ...plugin().manifestJson.memoryProvider!,
          recallToolName: "recall",
        },
      },
    })]);
    expect(isDeclaredMemoryProviderTool(provider!, "recall")).toBe(true);
    expect(isDeclaredMemoryProviderTool(provider!, "unrelated")).toBe(false);
  });
});
