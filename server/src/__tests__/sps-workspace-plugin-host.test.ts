import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { HostServices, WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import { createSpsWorkspacePluginHostHandlers } from "../services/sps-workspace-plugin-host.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const manifest: PaperclipPluginManifestV1 = {
  id: "sps.workspace-host-test", apiVersion: 1, version: "1.0.0", displayName: "Host fixture",
  description: "Fixture", author: "SPS", categories: ["automation"],
  capabilities: ["plugin.state.read", "plugin.state.write", "sps.models.submit"],
  entrypoints: { worker: "./host-worker.js", workspaceWorker: "./workspace-worker.js" },
};

describe("SPS Workspace Plugin Host handlers", () => {
  it("requires the fixed Workspace context and scopes config reads to its closure", async () => {
    const readConfig = vi.fn(async () => ({ selected: workspaceA }));
    const handlers = createSpsWorkspacePluginHostHandlers({
      workspaceId: workspaceA, pluginId, manifest, services: {} as HostServices, readConfig,
    });
    const configGet = handlers["config.get"]!;
    await expect(configGet({}, undefined)).rejects.toThrow();
    await expect(configGet({}, { invocationScope: { companyId: workspaceB } })).rejects.toThrow();
    await expect(configGet({}, { invalidInvocationScope: true, invocationScope: { companyId: workspaceA } }))
      .rejects.toThrow();
    expect(readConfig).not.toHaveBeenCalled();
    await expect(configGet({}, { invocationScope: { companyId: workspaceA } })).resolves.toEqual({ selected: workspaceA });
    expect(readConfig).toHaveBeenCalledTimes(1);
  });

  it("allows company state only, denies cross-Workspace and instance state before delegation", async () => {
    const get = vi.fn(async (params: unknown) => params);
    const set = vi.fn(async (params: unknown) => params);
    const handlers = createSpsWorkspacePluginHostHandlers({ workspaceId: workspaceA, pluginId, manifest,
      services: { state: { get, set } } as unknown as HostServices, readConfig: async () => ({}) });
    const context = { invocationScope: { companyId: workspaceA } } satisfies WorkerHostCallContext;
    await expect(handlers["state.get"]!({ scopeKind: "company", scopeId: workspaceA, key: "prefs" }, context))
      .resolves.toMatchObject({ scopeId: workspaceA });
    await expect(handlers["state.get"]!({ scopeKind: "company", scopeId: workspaceB, key: "prefs" }, context)).rejects.toThrow();
    await expect(handlers["state.set"]!({ scopeKind: "instance", scopeId: "host", key: "prefs", value: {} }, context))
      .rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it("keeps SPS model scope checks and omits privileged generic handlers", async () => {
    const submit = vi.fn(async (params: unknown) => ({ accepted: true, params }));
    const handlers = createSpsWorkspacePluginHostHandlers({ workspaceId: workspaceA, pluginId, manifest,
      services: { sps: { models: { submit } } } as unknown as HostServices, readConfig: async () => ({}) });
    const context = { invocationScope: { companyId: workspaceA } } satisfies WorkerHostCallContext;
    const request = { companyId: workspaceA, connectionId: "44444444-4444-4444-8444-444444444444", requestKey: "key", input: "hi" };
    await expect(handlers["sps.models.submit"]!(request, context)).resolves.toMatchObject({ accepted: true });
    await expect(handlers["sps.models.submit"]!({ ...request, companyId: workspaceB }, context)).rejects.toThrow();
    expect(submit).toHaveBeenCalledTimes(1);
    for (const unavailable of ["db.query", "db.execute", "secrets.resolve", "http.request", "events.on",
      "jobs.schedule", "agentTools.replaceDynamic"]) {
      expect(Object.hasOwn(handlers, unavailable)).toBe(false);
    }
    expect(Object.keys(handlers)).not.toContain("agentTools.replaceDynamic");
  });

  it("allows only company-scoped entity operations for its fixed Workspace", async () => {
    const upsert = vi.fn(async (params: unknown) => params);
    const list = vi.fn(async (params: unknown) => [params]);
    const handlers = createSpsWorkspacePluginHostHandlers({ workspaceId: workspaceA, pluginId, manifest,
      services: { entities: { upsert, list } } as unknown as HostServices, readConfig: async () => ({}) });
    const context = { invocationScope: { companyId: workspaceA } } satisfies WorkerHostCallContext;
    const valid = { entityType: "record", scopeKind: "company", scopeId: workspaceA, data: {} };
    await expect(handlers["entities.upsert"]!(valid, context)).resolves.toMatchObject(valid);
    await expect(handlers["entities.list"]!({}, context)).resolves.toEqual([{}]);
    await expect(handlers["entities.upsert"]!({ ...valid, scopeId: workspaceB }, context)).rejects.toThrow();
    await expect(handlers["entities.list"]!({ scopeKind: "instance" }, context)).rejects.toThrow();
    await expect(handlers["entities.list"]!({ scopeKind: "company", scopeId: workspaceB }, context)).rejects.toThrow();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
