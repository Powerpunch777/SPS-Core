import { describe, expect, it } from "vitest";
import type { MemoryProviderDescriptor } from "./memory-providers.js";
import { resolveEffectiveMemoryProvider } from "./memory-provider-runtime.js";

const defaultProvider: MemoryProviderDescriptor = {
  pluginId: "plugin-default",
  pluginKey: "sps.default-memory",
  providerKey: "sps-default",
  displayName: "SPS Default Memory",
  scopes: ["company", "project"],
  lifecycleEvents: ["task.completed"],
  recallToolName: "memory-recall",
  proposeToolName: "memory-propose",
  defaultForNewCompanies: true,
};

describe("resolveEffectiveMemoryProvider", () => {
  it("uses the declared default without persisting a company-specific override", () => {
    const selection = resolveEffectiveMemoryProvider({ providers: [defaultProvider], stored: null });
    expect(selection).toMatchObject({
      provider: expect.objectContaining({ providerKey: "sps-default" }),
      status: "enabled",
      source: "default",
    });
  });

  it("honors an explicit disabled setting over a default provider", () => {
    const selection = resolveEffectiveMemoryProvider({
      providers: [defaultProvider],
      stored: {
        status: "disabled",
        configuredByUserId: "owner-1",
        lastDeliveryAt: null,
        lastError: null,
      } as never,
    });
    expect(selection).toMatchObject({ provider: null, status: "disabled", source: "disabled" });
  });

  it("keeps an unavailable configured provider explicit instead of silently switching", () => {
    const selection = resolveEffectiveMemoryProvider({
      providers: [defaultProvider],
      stored: {
        status: "enabled",
        providerPluginId: "removed-plugin",
        providerKey: "removed-provider",
        configuredByUserId: "owner-1",
        lastDeliveryAt: null,
        lastError: "Previous delivery failed",
      } as never,
    });
    expect(selection).toMatchObject({
      provider: null,
      status: "enabled",
      source: "unavailable",
      configuredProviderKey: "removed-provider",
    });
  });

  it("restores a configured provider by stable key after its plugin record changes", () => {
    const selection = resolveEffectiveMemoryProvider({
      providers: [{ ...defaultProvider, pluginId: "plugin-reinstalled" }],
      stored: {
        status: "enabled",
        providerPluginId: "plugin-removed",
        providerKey: "sps-default",
        configuredByUserId: "owner-1",
        lastDeliveryAt: null,
        lastError: null,
      } as never,
    });
    expect(selection).toMatchObject({
      provider: expect.objectContaining({ pluginId: "plugin-reinstalled" }),
      source: "configured",
      configuredProviderKey: "sps-default",
    });
  });
});
