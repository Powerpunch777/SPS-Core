import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { activityLog, companies, plugins, spsWorkspacePluginRuntimeConfigs, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import {
  createSpsWorkspacePluginConfigService,
  validateSpsWorkspacePluginConfig,
} from "./sps-workspace-plugin-config.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";
const manifest: PaperclipPluginManifestV1 = {
  id: "sps.workspace-config-test", apiVersion: 1, version: "1.0.0", displayName: "Workspace config test",
  description: "Fixture", author: "SPS", categories: ["automation"], capabilities: ["jobs.schedule"],
  entrypoints: { worker: "./worker.js", workspaceWorker: "./workspace-worker.js" },
  workspaceConfigSchema: {
    type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } }, required: ["mode"], additionalProperties: false,
  },
};

function fakeDb() {
  let config: Record<string, any> | undefined;
  const audits: Record<string, any>[] = [];
  const workspace = { id: workspaceId };
  const plugin = { id: pluginId, status: "ready", manifestJson: manifest };
  function rowsFor(table: unknown) {
    if (table === companies) return [workspace];
    if (table === plugins) return [plugin];
    if (table === spsWorkspacePluginRuntimeConfigs) return config ? [config] : [];
    return [];
  }
  function select() {
    return { from(table: unknown) {
      const query: any = {
        where: () => query,
        for: () => query,
        limit: async () => rowsFor(table),
      };
      return query;
    } };
  }
  const db: any = {
    select,
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
    insert(table: unknown) {
      return { values(values: Record<string, any>) {
        if (table === activityLog) {
          audits.push(values);
          return Promise.resolve(undefined);
        }
        if (table === spsWorkspacePluginRuntimeConfigs) {
          config = { ...values, revision: randomUUID(), createdAt: new Date(), updatedAt: values.updatedAt };
          return { returning: async () => [config] };
        }
        return Promise.resolve(undefined);
      } };
    },
    update(table: unknown) {
      return { set(values: Record<string, any>) {
        const query: any = { where: () => query, returning: async () => {
          if (table === spsWorkspacePluginRuntimeConfigs && config) {
            config = { ...config, ...values, revision: randomUUID() };
            return [config];
          }
          return [];
        } };
        return query;
      } };
    },
    delete(table: unknown) {
      return { where: async () => { if (table === spsWorkspacePluginRuntimeConfigs) config = undefined; } };
    },
  };
  return { db: db as Db, audits, readConfig: () => config };
}

describe("Workspace Plugin runtime configuration", () => {
  it("validates and freezes bounded nonsecret config against the dedicated schema", () => {
    const validated = validateSpsWorkspacePluginConfig(manifest, { mode: "a" });
    expect(validated).toEqual({ mode: "a" });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(() => validateSpsWorkspacePluginConfig(manifest, { mode: "other" })).toThrow(HttpError);
    expect(() => validateSpsWorkspacePluginConfig({ ...manifest, workspaceConfigSchema: undefined }, { mode: "a" })).toThrow(HttpError);
    expect(() => validateSpsWorkspacePluginConfig(manifest, { mode: "a", nested: { constructor: "blocked" } })).toThrow(HttpError);
  });

  it("returns an empty UI snapshot before required config exists, then uses strict revision concurrency", async () => {
    const fake = fakeDb();
    const service = createSpsWorkspacePluginConfigService(fake.db);
    await expect(service.get(workspaceId, pluginId)).resolves.toMatchObject({ configJson: {}, revision: null, updatedAt: null });
    const first = await service.put({ workspaceId, pluginId, configJson: { mode: "a" }, expectedRevision: null, actorUserId: "host-user" });
    expect(first.revision).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fake.audits[0]).toMatchObject({ details: { revision: first.revision } });
    expect(fake.audits[0]).not.toHaveProperty("configJson");
    await expect(service.put({ workspaceId, pluginId, configJson: { mode: "b" }, expectedRevision: null, actorUserId: "host-user" }))
      .rejects.toMatchObject({ status: 409 });
    const second = await service.put({ workspaceId, pluginId, configJson: { mode: "b" }, expectedRevision: first.revision, actorUserId: "host-user" });
    expect(second.revision).not.toBe(first.revision);
    await expect(service.remove({ workspaceId, pluginId, expectedRevision: first.revision, actorUserId: "host-user" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.remove({ workspaceId, pluginId, expectedRevision: second.revision, actorUserId: "host-user" }))
      .resolves.toMatchObject({ configJson: {}, revision: null });
    expect(fake.readConfig()).toBeUndefined();
  });

  it("keeps absent workspace schemas strict and rejects secret-ref usage", () => {
    const noSchema = { ...manifest, workspaceConfigSchema: undefined };
    expect(validateSpsWorkspacePluginConfig(noSchema, {})).toEqual({});
    expect(() => validateSpsWorkspacePluginConfig(noSchema, { arbitrary: "value" })).toThrow(HttpError);
    expect(() => validateSpsWorkspacePluginConfig({
      ...noSchema,
      instanceConfigSchema: { type: "object", properties: { mode: { type: "string" } }, additionalProperties: false },
    }, { mode: "a" })).toThrow(HttpError);
    expect(() => validateSpsWorkspacePluginConfig(manifest, { mode: "a", credential: "44444444-4444-4444-8444-444444444444" }))
      .toThrow(HttpError);
    expect(() => validateSpsWorkspacePluginConfig({ ...manifest,
      workspaceConfigSchema: { type: "object", properties: { credential: { type: "string", format: "secret-ref" } } },
    }, { credential: "44444444-4444-4444-8444-444444444444" })).toThrow(HttpError);
  });

  it("accepts declared broker connection identifiers without enabling raw secret references", () => {
    const configured = { modelConnectionId: "44444444-4444-4444-8444-444444444444" };
    expect(validateSpsWorkspacePluginConfig({ ...manifest,
      workspaceConfigSchema: { type: "object", properties: { modelConnectionId: { type: "string", format: "uuid" } },
        required: ["modelConnectionId"], additionalProperties: false },
    }, configured)).toEqual(configured);
  });

  it("rejects async schemas before a validator promise can bypass configuration validation", () => {
    expect(() => validateSpsWorkspacePluginConfig({ ...manifest,
      workspaceConfigSchema: { $async: true, type: "object", required: ["missing"] },
    }, {})).toThrow(HttpError);
  });
});
