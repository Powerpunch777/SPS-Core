import { and, eq } from "drizzle-orm";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import {
  activityLog,
  companies,
  plugins,
  spsWorkspacePluginRuntimeConfigs,
  type Db,
} from "../compat/paperclip/db.js";
import { pluginManifestV1Schema, type JsonSchema, type PaperclipPluginManifestV1 } from "../compat/paperclip/shared.js";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_DEPTH = 32;
const MAX_CONFIG_NODES = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMPTY_WORKSPACE_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export type SpsWorkspacePluginConfigSnapshot = Readonly<{
  workspaceId: string;
  pluginId: string;
  configJson: Readonly<Record<string, unknown>>;
  revision: string | null;
  updatedAt: string | null;
}>;

function invalidConfig(): never {
  throw unprocessable("Workspace plugin runtime configuration is invalid.");
}

function copyBoundedJsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalidConfig();
  let nodes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > MAX_CONFIG_NODES || depth > MAX_CONFIG_DEPTH) invalidConfig();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return Object.freeze(item.map((entry) => copy(entry, depth + 1)));
    if (!item || typeof item !== "object"
      || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) invalidConfig();
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") invalidConfig();
      output[key] = copy(child, depth + 1);
    }
    return Object.freeze(output);
  }
  const result = copy(value, 0) as Readonly<Record<string, unknown>>;
  let serialized: string;
  try { serialized = JSON.stringify(result); } catch { return invalidConfig(); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) invalidConfig();
  return result;
}

function manifestForWorkspaceWorker(input: unknown): ReturnType<typeof pluginManifestV1Schema.parse> {
  const parsed = pluginManifestV1Schema.safeParse(input);
  if (!parsed.success || !parsed.data.entrypoints.workspaceWorker) {
    throw conflict("This Plugin does not declare a valid Workspace worker.");
  }
  return parsed.data;
}

/** Pure validation used by the settings service and Workspace worker factory. */
export function validateSpsWorkspacePluginConfig(
  manifestInput: PaperclipPluginManifestV1 | unknown,
  configInput: unknown,
): Readonly<Record<string, unknown>> {
  const manifest = manifestForWorkspaceWorker(manifestInput);
  const config = copyBoundedJsonRecord(configInput);
  const schema = manifest.workspaceConfigSchema ?? EMPTY_WORKSPACE_CONFIG_SCHEMA;
  // The validated Workspace schema rejects secret-ref declarations and this
  // runtime has no raw secret resolver. Ordinary declared UUID identifiers
  // (for example a brokered model connection ID) are configuration, not grants.

  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true, ownProperties: true });
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  let valid: ReturnType<typeof ajv.compile>;
  try { valid = ajv.compile(schema); } catch { return invalidConfig(); }
  // This API is deliberately synchronous. Calling an async AJV validator would
  // treat its Promise as success and could persist invalid config before reject.
  if (valid.$async === true) return invalidConfig();
  if (!valid(config)) {
    // Do not surface schema values or offending configuration content.
    const safeErrors = (valid.errors ?? []).slice(0, 100).map((error: ErrorObject) => ({
      field: error.instancePath || "/",
      message: error.keyword,
    }));
    throw unprocessable("Workspace plugin runtime configuration is invalid.", safeErrors);
  }
  return config;
}

function snapshot(
  workspaceId: string,
  pluginId: string,
  row?: typeof spsWorkspacePluginRuntimeConfigs.$inferSelect,
): SpsWorkspacePluginConfigSnapshot {
  return Object.freeze({
    workspaceId,
    pluginId,
    configJson: copyBoundedJsonRecord(row?.configJson ?? {}),
    revision: row?.revision ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
}

function assertIds(workspaceId: string, pluginId: string) {
  if (!UUID.test(workspaceId) || !UUID.test(pluginId)) throw badRequest("Workspace and Plugin identifiers must be UUIDs.");
}

function assertExpectedRevision(value: string | null) {
  if (value !== null && !UUID.test(value)) throw badRequest("expectedRevision must be a revision UUID or null.");
}

export function createSpsWorkspacePluginConfigService(db: Db) {
  async function lockAndRead(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], workspaceId: string, pluginId: string) {
    const [workspace] = await tx.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, workspaceId)).for("update").limit(1);
    if (!workspace) throw notFound("Workspace not found.");
    const [plugin] = await tx.select({ id: plugins.id, status: plugins.status, manifestJson: plugins.manifestJson })
      .from(plugins).where(eq(plugins.id, pluginId)).for("update").limit(1);
    if (!plugin) throw notFound("Plugin not found.");
    const manifest = manifestForWorkspaceWorker(plugin.manifestJson);
    if (plugin.status !== "ready") throw conflict("Plugin must be ready to change Workspace runtime configuration.");
    const [row] = await tx.select().from(spsWorkspacePluginRuntimeConfigs)
      .where(and(
        eq(spsWorkspacePluginRuntimeConfigs.workspaceId, workspaceId),
        eq(spsWorkspacePluginRuntimeConfigs.pluginId, pluginId),
      )).for("update").limit(1);
    return { manifest, row };
  }

  async function audit(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], input: {
    workspaceId: string; pluginId: string; actorUserId: string | null; operation: "put" | "remove"; revision: string | null;
  }) {
    await tx.insert(activityLog).values({
      companyId: input.workspaceId,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId ?? "sps-core",
      action: `plugin.workspace_runtime_config.${input.operation}`,
      entityType: "plugin_workspace_runtime_config",
      entityId: input.pluginId,
      details: { revision: input.revision },
      agentId: null,
      runId: null,
    });
  }

  return {
    async get(workspaceId: string, pluginId: string): Promise<SpsWorkspacePluginConfigSnapshot> {
      assertIds(workspaceId, pluginId);
      const [workspace] = await db.select({ id: companies.id }).from(companies)
        .where(eq(companies.id, workspaceId)).limit(1);
      if (!workspace) throw notFound("Workspace not found.");
      const [plugin] = await db.select({ id: plugins.id, status: plugins.status, manifestJson: plugins.manifestJson })
        .from(plugins).where(eq(plugins.id, pluginId)).limit(1);
      if (!plugin) throw notFound("Plugin not found.");
      manifestForWorkspaceWorker(plugin.manifestJson);
      if (plugin.status !== "ready") throw conflict("Plugin must be ready to read Workspace runtime configuration.");
      const [row] = await db.select().from(spsWorkspacePluginRuntimeConfigs)
        .where(and(
          eq(spsWorkspacePluginRuntimeConfigs.workspaceId, workspaceId),
          eq(spsWorkspacePluginRuntimeConfigs.pluginId, pluginId),
        )).limit(1);
      return snapshot(workspaceId, pluginId, row);
    },

    async put(input: {
      workspaceId: string; pluginId: string; configJson: unknown; expectedRevision: string | null; actorUserId: string | null;
    }): Promise<SpsWorkspacePluginConfigSnapshot> {
      assertIds(input.workspaceId, input.pluginId);
      assertExpectedRevision(input.expectedRevision);
      return db.transaction(async (tx) => {
        const { manifest, row } = await lockAndRead(tx, input.workspaceId, input.pluginId);
        if ((row?.revision ?? null) !== input.expectedRevision) throw conflict("Workspace Plugin config changed; refresh and retry.");
        const configJson = validateSpsWorkspacePluginConfig(manifest, input.configJson);
        const now = new Date();
        const values = { configJson: { ...configJson }, updatedByUserId: input.actorUserId, updatedAt: now };
        const [updated] = row
          ? await tx.update(spsWorkspacePluginRuntimeConfigs).set(values)
            .where(and(
              eq(spsWorkspacePluginRuntimeConfigs.workspaceId, input.workspaceId),
              eq(spsWorkspacePluginRuntimeConfigs.pluginId, input.pluginId),
              eq(spsWorkspacePluginRuntimeConfigs.revision, row.revision),
            )).returning()
          : await tx.insert(spsWorkspacePluginRuntimeConfigs).values({
            workspaceId: input.workspaceId, pluginId: input.pluginId, ...values,
          }).returning();
        if (!updated) throw conflict("Workspace Plugin config changed; refresh and retry.");
        await audit(tx, { workspaceId: input.workspaceId, pluginId: input.pluginId, actorUserId: input.actorUserId,
          operation: "put", revision: updated.revision });
        return snapshot(input.workspaceId, input.pluginId, updated);
      });
    },

    async remove(input: {
      workspaceId: string; pluginId: string; expectedRevision: string | null; actorUserId: string | null;
    }): Promise<SpsWorkspacePluginConfigSnapshot> {
      assertIds(input.workspaceId, input.pluginId);
      assertExpectedRevision(input.expectedRevision);
      return db.transaction(async (tx) => {
        const { row } = await lockAndRead(tx, input.workspaceId, input.pluginId);
        if ((row?.revision ?? null) !== input.expectedRevision) throw conflict("Workspace Plugin config changed; refresh and retry.");
        if (row) {
          await tx.delete(spsWorkspacePluginRuntimeConfigs).where(and(
            eq(spsWorkspacePluginRuntimeConfigs.workspaceId, input.workspaceId),
            eq(spsWorkspacePluginRuntimeConfigs.pluginId, input.pluginId),
            eq(spsWorkspacePluginRuntimeConfigs.revision, row.revision),
          ));
        }
        await audit(tx, { workspaceId: input.workspaceId, pluginId: input.pluginId, actorUserId: input.actorUserId,
          operation: "remove", revision: row?.revision ?? null });
        return snapshot(input.workspaceId, input.pluginId);
      });
    },
  };
}
