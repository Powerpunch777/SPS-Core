import { describe, expect, it, vi } from "vitest";
import { createPluginUiActionAuthority, type PluginUiActionActor } from "./plugin-ui-action-authority.js";

const permission = "agents:configure" as const;

function actor(overrides: Partial<PluginUiActionActor> = {}): PluginUiActionActor {
  return { type: "user", userId: "user-1", agentId: null, runId: null,
    companyId: "company-1", hostAuthority: false, ...overrides };
}

describe("shared Plugin UI action authority", () => {
  it("filters and de-duplicates only known permission requests", () => {
    const service = createPluginUiActionAuthority({ canUser: vi.fn(), hasPermission: vi.fn() });
    expect(service.requestedPermissions({ __paperclipRequestedPermissions: [permission, permission, "forged:admin", 1] }))
      .toEqual([permission]);
    expect(service.requestedPermissions({ __paperclipRequestedPermissions: "agents:configure" })).toEqual([]);
  });

  it("keeps a viewer actor but omits permissions when no grants are allowed", async () => {
    const access = { canUser: vi.fn().mockResolvedValue(false), hasPermission: vi.fn().mockResolvedValue(false) };
    const service = createPluginUiActionAuthority(access);
    const result = await service.actorContext(actor(), [permission]);
    expect(result).toEqual({ type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1" });
    expect(access.canUser).toHaveBeenCalledWith("company-1", "user-1", permission);
    expect(access.hasPermission).not.toHaveBeenCalled();
  });

  it("calculates user and agent grants through their existing access checks", async () => {
    const access = { canUser: vi.fn().mockResolvedValue(true), hasPermission: vi.fn().mockResolvedValue(true) };
    const service = createPluginUiActionAuthority(access);
    await expect(service.actorContext(actor(), [permission])).resolves.toEqual({
      type: "user", userId: "user-1", agentId: null, runId: null, companyId: "company-1", permissions: [permission],
    });
    await expect(service.actorContext(actor({ type: "agent", userId: null, agentId: "agent-1" }), [permission])).resolves.toEqual({
      type: "agent", userId: null, agentId: "agent-1", runId: null, companyId: "company-1", permissions: [permission],
    });
    expect(access.hasPermission).toHaveBeenCalledWith("company-1", "agent", "agent-1", permission);
  });

  it("preserves only explicit Host-authority permission passthrough", async () => {
    const access = { canUser: vi.fn(), hasPermission: vi.fn() };
    const service = createPluginUiActionAuthority(access);
    await expect(service.actorContext(actor({ type: "system", userId: null, hostAuthority: true }), [permission]))
      .resolves.toEqual({ type: "system", userId: null, agentId: null, runId: null,
        companyId: "company-1", permissions: [permission] });
    expect(access.canUser).not.toHaveBeenCalled();
    expect(access.hasPermission).not.toHaveBeenCalled();
  });

  it("strips caller permission requests and overwrites caller company scope", () => {
    const service = createPluginUiActionAuthority({ canUser: vi.fn(), hasPermission: vi.fn() });
    expect(service.actionParams({ companyId: "foreign", value: true,
      __paperclipRequestedPermissions: ["agents:configure"] }, "company-1"))
      .toEqual({ value: true, companyId: "company-1" });
    expect(service.actionParams({ companyId: "caller", __paperclipRequestedPermissions: [permission] }, undefined))
      .toEqual({ companyId: "caller" });
  });
});
