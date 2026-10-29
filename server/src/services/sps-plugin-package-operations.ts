import { and, eq, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v3";
import { pluginManifestV1Schema, type PluginRecord } from "@paperclipai/shared";
import { plugins, spsPluginPackageOperations, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

const pendingMessage = "Plugin package removal requires recovery before it can run or change again.";
const snapshotSchema = z.object({
  id: z.string().uuid(), pluginKey: z.string().min(1), packageName: z.string().min(1),
  packagePath: z.string().nullable(), version: z.string().min(1),
  manifestJson: pluginManifestV1Schema,
  status: z.enum(["installed", "ready", "disabled", "error", "upgrade_pending", "uninstalled"]),
}).passthrough();

export type SpsPluginPackageOperation = {
  id: string;
  pluginId: string;
  pluginKey: string;
  kind: "uninstall";
  snapshot: PluginRecord;
  removeData: boolean;
};

export interface SpsPluginPackageOperations {
  beginUninstall(snapshot: PluginRecord, removeData: boolean): Promise<SpsPluginPackageOperation>;
  pendingForPlugin(pluginId: string): Promise<SpsPluginPackageOperation | null>;
  listPending(): Promise<SpsPluginPackageOperation[]>;
  assertClear(pluginId?: string, pluginKey?: string): Promise<void>;
  complete(operationId: string): Promise<void>;
}

export function samePluginPackageArtifact(current: PluginRecord, snapshot: PluginRecord): boolean {
  return current.id === snapshot.id && current.pluginKey === snapshot.pluginKey
    && current.packageName === snapshot.packageName && current.packagePath === snapshot.packagePath
    && current.version === snapshot.version && isDeepStrictEqual(current.manifestJson, snapshot.manifestJson);
}

function decode(row: typeof spsPluginPackageOperations.$inferSelect): SpsPluginPackageOperation {
  const snapshot = snapshotSchema.safeParse(row.snapshotJson);
  if (row.kind !== "uninstall" || !snapshot.success || snapshot.data.id !== row.pluginId
    || snapshot.data.pluginKey !== row.pluginKey || snapshot.data.manifestJson.id !== row.pluginKey
    || row.activePluginId !== row.pluginId || row.completedAt !== null) {
    throw new Error("Plugin package recovery record is invalid; artifacts were preserved.");
  }
  // Dates and unused metadata are not execution authority. Keep the exact
  // persisted manifest/path rather than importing code from a damaged package.
  return { id: row.id, pluginId: row.pluginId, pluginKey: row.pluginKey, kind: "uninstall",
    snapshot: row.snapshotJson as unknown as PluginRecord, removeData: row.removeData };
}

/** Host-private durable intent. No SDK grant, process-exit proof, or package trust. */
export function createSpsPluginPackageOperations(db: Db): SpsPluginPackageOperations {
  const table = spsPluginPackageOperations;
  return {
    async beginUninstall(snapshot, removeData) {
      // The row lock serializes reservations against another Core composition.
      // Intent and non-running status commit together before artifact deletion.
      return db.transaction(async tx => {
        const [current] = await tx.select().from(plugins).where(eq(plugins.id, snapshot.id)).for("update");
        if (!current || !samePluginPackageArtifact(current as PluginRecord, snapshot)) {
          throw conflict("Plugin changed before package removal; refresh and retry.");
        }
        const [existing] = await tx.select().from(table).where(eq(table.activePluginId, snapshot.id));
        if (existing) {
          const operation = decode(existing);
          if (operation.removeData !== removeData || !samePluginPackageArtifact(snapshot, operation.snapshot)) {
            throw conflict(pendingMessage);
          }
          return operation;
        }
        const [row] = await tx.insert(table).values({
          pluginId: snapshot.id, pluginKey: snapshot.pluginKey, kind: "uninstall",
          snapshotJson: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>,
          removeData, activePluginId: snapshot.id,
        }).returning();
        if (!row) throw new Error("Plugin package removal intent was not persisted.");
        if (current.status !== "uninstalled") {
          await tx.update(plugins).set({ status: "error", lastError: pendingMessage, updatedAt: new Date() })
            .where(eq(plugins.id, snapshot.id));
        }
        return decode(row);
      });
    },
    async pendingForPlugin(pluginId) {
      const [row] = await db.select().from(table).where(eq(table.activePluginId, pluginId));
      return row ? decode(row) : null;
    },
    async listPending() {
      const rows = await db.select().from(table).where(isNull(table.completedAt)).orderBy(table.createdAt);
      return rows.map(decode);
    },
    async assertClear(pluginId, pluginKey) {
      if (!pluginId && !pluginKey) throw new Error("Plugin package authority selector is missing.");
      const [pending] = await db.select({ id: table.id }).from(table).where(and(
        isNull(table.completedAt),
        pluginId ? eq(table.pluginId, pluginId) : eq(table.pluginKey, pluginKey!),
      )).limit(1);
      if (pending) throw conflict(pendingMessage, { code: "sps_plugin_package_recovery_required" });
    },
    async complete(operationId) {
      await db.update(table).set({ activePluginId: null, completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(table.id, operationId), isNull(table.completedAt)));
    },
  };
}
