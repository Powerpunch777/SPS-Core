import { describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";
import { createPluginToolAccessService, pluginRequiresExplicitToolGrant } from "./plugin-tool-access.js";

function plugin(policy?: "company_default" | "explicit_grant"): PluginRecord {
  return {
    id: "plugin-1",
    pluginKey: "sps.mcp-connector",
    packageName: "@sps/plugin-mcp-connector",
    version: "0.1.0",
    apiVersion: 1,
    categories: ["automation"],
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-07-22T00:00:00.000Z"),
    updatedAt: new Date("2026-07-22T00:00:00.000Z"),
    manifestJson: policy ? { agentToolAccess: policy } : {} as PluginRecord["manifestJson"],
  } as PluginRecord;
}

function grantLookupDb(rows: Array<{ id: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
}

describe("plugin tool access policy", () => {
  it("keeps legacy or company-default plugins available", async () => {
    expect(pluginRequiresExplicitToolGrant({ manifestJson: undefined } as never)).toBe(false);
    expect(pluginRequiresExplicitToolGrant(plugin("company_default"))).toBe(false);

    const service = createPluginToolAccessService(grantLookupDb([]) as never);
    await expect(service.isAllowed({ companyId: "company-1", plugin: plugin(), agentId: "agent-1" })).resolves.toBe(true);
  });

  it("requires an active row for an explicit-grant plugin", async () => {
    expect(pluginRequiresExplicitToolGrant(plugin("explicit_grant"))).toBe(true);

    const denied = createPluginToolAccessService(grantLookupDb([]) as never);
    const allowed = createPluginToolAccessService(grantLookupDb([{ id: "grant-1" }]) as never);
    await expect(denied.isAllowed({ companyId: "company-1", plugin: plugin("explicit_grant"), agentId: "agent-1" })).resolves.toBe(false);
    await expect(allowed.isAllowed({ companyId: "company-1", plugin: plugin("explicit_grant"), agentId: "agent-1" })).resolves.toBe(true);
  });

  it("stores a stable error code instead of a raw plugin error", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const service = createPluginToolAccessService({
      insert: vi.fn(() => ({ values })),
    } as never);

    await service.record({
      companyId: "company-1",
      pluginId: "plugin-1",
      agentId: "agent-1",
      runId: null,
      projectId: null,
      toolName: "sps.mcp-connector:remote-tool",
      status: "failed",
      errorCode: "PLUGIN_TOOL_EXECUTION_FAILED",
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      error: "PLUGIN_TOOL_EXECUTION_FAILED",
    }));
  });
});
