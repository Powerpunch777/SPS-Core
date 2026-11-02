import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { companyMemberships, pluginEntities } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { assertSpsWorkspaceInboxTargetMember, createPluginHostEntityService } from "../services/plugin-host-services.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const pluginId = "33333333-3333-4333-8333-333333333333";

describe("Workspace-scoped plugin entities", () => {
  it("binds upserts to the trusted Workspace and rejects other scopes or tenant IDs", async () => {
    const upsertEntity = vi.fn(async (_pluginId: string, input: unknown) => input);
    const listEntities = vi.fn(async () => []);
    const entities = createPluginHostEntityService({ upsertEntity, listEntities } as any, pluginId, workspaceId);
    await expect(entities.upsert({ entityType: "record", scopeKind: "company", scopeId: workspaceId, data: { ok: true } }))
      .resolves.toMatchObject({ companyId: workspaceId, scopeKind: "company", scopeId: workspaceId });
    expect(upsertEntity).toHaveBeenCalledTimes(1);
    await expect(entities.upsert({ entityType: "record", scopeKind: "company", scopeId: otherWorkspaceId, data: {} }))
      .rejects.toThrow(/owning company scope/i);
    await expect(entities.upsert({ entityType: "record", scopeKind: "instance", data: {} } as any))
      .rejects.toThrow(/owning company scope/i);
    await expect(entities.upsert({ entityType: "record", scopeKind: "company", scopeId: workspaceId,
      companyId: otherWorkspaceId, data: {} } as any)).rejects.toThrow(/another Workspace/i);
    expect(upsertEntity).toHaveBeenCalledTimes(1);
  });

  it("defaults entity lists to the Workspace and asks the registry for tenant filtering", async () => {
    const upsertEntity = vi.fn();
    const listEntities = vi.fn(async () => []);
    const entities = createPluginHostEntityService({ upsertEntity, listEntities } as any, pluginId, workspaceId);
    await entities.list({});
    expect(listEntities).toHaveBeenCalledWith(pluginId, { scopeKind: "company", scopeId: workspaceId }, workspaceId);
    await expect(entities.list({ scopeKind: "instance" } as any)).rejects.toThrow(/owning company scope/i);
    await expect(entities.list({ scopeKind: "company", scopeId: otherWorkspaceId })).rejects.toThrow(/owning company scope/i);
    await expect(entities.list({ companyId: otherWorkspaceId } as any)).rejects.toThrow(/owning company scope/i);
    expect(listEntities).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy Host list scope while a Workspace registry query has a company_id predicate", async () => {
    let capturedWhere: any;
    const db: any = {
      select: () => ({ from: (table: unknown) => {
        expect(table).toBe(pluginEntities);
        return { where: (condition: unknown) => {
          capturedWhere = condition;
          return { orderBy: () => ({ limit: () => ({ offset: async () => [] }) }) };
        } };
      } }),
    };
    const registry = pluginRegistryService(db);
    await registry.listEntities(pluginId, { scopeKind: "company", scopeId: workspaceId }, workspaceId);
    const query = new PgDialect().sqlToQuery(capturedWhere);
    expect(query.sql).toContain('"plugin_entities"."company_id" =');
    expect(query.params).toContain(workspaceId);

    capturedWhere = undefined;
    await registry.listEntities(pluginId, { scopeKind: "company", scopeId: workspaceId });
    expect(capturedWhere).toBeDefined();
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).not.toContain('"plugin_entities"."company_id" =');
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).not.toContain('"plugin_entities"."scope_id" =');
  });

  it("requires an active Workspace membership before targeting an inbox item", async () => {
    let capturedWhere: any;
    let membershipFound = true;
    const db: any = {
      select: () => ({ from: (table: unknown) => {
        expect(table).toBe(companyMemberships);
        return { where: (condition: unknown) => {
          capturedWhere = condition;
          return { limit: async () => membershipFound ? [{ id: "membership" }] : [] };
        } };
      } }),
    };
    await expect(assertSpsWorkspaceInboxTargetMember(db, workspaceId, "workspace-user" )).resolves.toBeUndefined();
    const query = new PgDialect().sqlToQuery(capturedWhere);
    expect(query.sql).toContain('"company_memberships"."company_id" =');
    expect(query.sql).toContain('"company_memberships"."principal_id" =');
    expect(query.params).toEqual(expect.arrayContaining([workspaceId, "user", "workspace-user", "active"]));
    membershipFound = false;
    await expect(assertSpsWorkspaceInboxTargetMember(db, workspaceId, "other-workspace-user"))
      .rejects.toThrow(/active member/i);
    await expect(assertSpsWorkspaceInboxTargetMember(db, workspaceId, null)).resolves.toBeUndefined();
  });
});
