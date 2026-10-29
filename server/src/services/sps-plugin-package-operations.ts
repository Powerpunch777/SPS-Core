import { and, eq, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v3";
import { pluginManifestV1Schema, type PluginRecord } from "../compat/paperclip/shared.js";
import { plugins, spsPluginPackageOperations, type Db } from "../compat/paperclip/db.js";
import { conflict } from "../errors.js";

const pendingMessage = "Plugin package operation requires recovery before it can run or change again.";
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

export type SpsPluginUpgradePhase = "prepared" | "committing" | "committed" | "activation_entered" | "rollback_required";
export type SpsPluginUpgradeOutcome = "succeeded" | "rolled_back" | "review_required";
export type SpsPluginUpgradeOperation = {
  id: string; pluginId: string; pluginKey: string; kind: "upgrade";
  snapshot: PluginRecord; candidate: PluginRecord; phase: SpsPluginUpgradePhase;
  databaseMayChange: boolean; approvedMigrationPlanHash: string | null; backupFile: string | null;
};
export type SpsPendingPackageOperation = SpsPluginPackageOperation | SpsPluginUpgradeOperation;

export interface SpsPluginUpgradeJournal {
  begin(snapshot: PluginRecord, candidate: PluginRecord, options: {
    databaseMayChange: boolean; approvedMigrationPlanHash: string | null; backupFile: string | null;
  }): Promise<SpsPluginUpgradeOperation>;
  run<T>(operationId: string, action: () => Promise<T>): Promise<T>;
  advance(operationId: string, phase: SpsPluginUpgradePhase): Promise<void>;
}

export interface SpsPluginPackageOperations {
  beginUninstall(snapshot: PluginRecord, removeData: boolean): Promise<SpsPluginPackageOperation>;
  pendingForPlugin(pluginId: string): Promise<SpsPendingPackageOperation | null>;
  listPending(): Promise<SpsPendingPackageOperation[]>;
  assertClear(pluginId?: string, pluginKey?: string): Promise<void>;
  complete(operationId: string, outcome?: SpsPluginUpgradeOutcome): Promise<void>;
  upgrade?: SpsPluginUpgradeJournal;
}

export function samePluginPackageArtifact(current: PluginRecord, snapshot: PluginRecord): boolean {
  return current.id === snapshot.id && current.pluginKey === snapshot.pluginKey
    && current.packageName === snapshot.packageName && current.packagePath === snapshot.packagePath
    && current.version === snapshot.version && isDeepStrictEqual(current.manifestJson, snapshot.manifestJson);
}

const upgradeSchema = z.object({
  previous: snapshotSchema, candidate: snapshotSchema,
  phase: z.enum(["prepared", "committing", "committed", "activation_entered", "rollback_required"]),
  databaseMayChange: z.boolean(), approvedMigrationPlanHash: z.string().nullable(), backupFile: z.string().nullable(),
});

function decode(row: typeof spsPluginPackageOperations.$inferSelect): SpsPendingPackageOperation {
  const upgraded = row.kind === "upgrade" ? upgradeSchema.safeParse(row.snapshotJson) : null;
  const snapshot = snapshotSchema.safeParse(upgraded?.success ? upgraded.data.previous : row.snapshotJson);
  if (!["uninstall", "upgrade"].includes(row.kind) || !snapshot.success || snapshot.data.id !== row.pluginId
    || snapshot.data.pluginKey !== row.pluginKey || snapshot.data.manifestJson.id !== row.pluginKey
    || row.activePluginId !== row.pluginId || row.completedAt !== null
    || (row.kind === "upgrade" && (!upgraded?.success || row.removeData
      || upgraded.data.candidate.id !== row.pluginId || upgraded.data.candidate.pluginKey !== row.pluginKey
      || upgraded.data.candidate.manifestJson.id !== row.pluginKey))) {
    throw new Error("Plugin package recovery record is invalid; artifacts were preserved.");
  }
  // Dates and unused metadata are not execution authority. Keep the exact
  // persisted manifest/path rather than importing code from a damaged package.
  if (row.kind === "upgrade" && upgraded?.success) {
    const data = row.snapshotJson as unknown as {
      previous: PluginRecord; candidate: PluginRecord; phase: SpsPluginUpgradePhase;
      databaseMayChange: boolean; approvedMigrationPlanHash: string | null; backupFile: string | null;
    };
    return { id: row.id, pluginId: row.pluginId, pluginKey: row.pluginKey, kind: "upgrade",
      snapshot: data.previous, candidate: data.candidate, phase: data.phase,
      databaseMayChange: data.databaseMayChange, approvedMigrationPlanHash: data.approvedMigrationPlanHash, backupFile: data.backupFile };
  }
  return { id: row.id, pluginId: row.pluginId, pluginKey: row.pluginKey, kind: "uninstall",
    snapshot: row.snapshotJson as unknown as PluginRecord, removeData: row.removeData };
}

/** Host-private durable intent. No SDK grant, process-exit proof, or package trust. */
export function createSpsPluginPackageOperations(db: Db): SpsPluginPackageOperations {
  const table = spsPluginPackageOperations;
  const context = new AsyncLocalStorage<{ operationId: string; active: boolean }>();
  const encode = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const upgrade: SpsPluginUpgradeJournal = {
    async begin(snapshot, candidate, options) {
      return db.transaction(async tx => {
        const [current] = await tx.select().from(plugins).where(eq(plugins.id, snapshot.id)).for("update");
        if (!current || !samePluginPackageArtifact(current as PluginRecord, snapshot)) {
          throw conflict("Plugin changed before package update; refresh and retry.");
        }
        const [pending] = await tx.select().from(table).where(eq(table.activePluginId, snapshot.id));
        if (pending) throw conflict("Plugin package recovery must finish before another update.");
        const [row] = await tx.insert(table).values({ pluginId: snapshot.id, pluginKey: snapshot.pluginKey,
          kind: "upgrade", activePluginId: snapshot.id, snapshotJson: encode({ previous: snapshot, candidate, phase: "prepared", ...options }) }).returning();
        if (!row) throw new Error("Plugin update intent was not persisted.");
        const operation = decode(row);
        if (operation.kind !== "upgrade") throw new Error("Plugin update intent has an invalid kind.");
        await tx.update(plugins).set({ status: "error", lastError: "Plugin package update requires recovery.", updatedAt: new Date() })
          .where(eq(plugins.id, snapshot.id));
        return operation;
      });
    },
    async run(operationId, action) {
      const [row] = await db.select().from(table).where(eq(table.id, operationId));
      if (!row || decode(row).kind !== "upgrade") throw conflict("Plugin update intent is unavailable.");
      const owner = { operationId, active: true };
      return context.run(owner, async () => {
        try { return await action(); } finally { owner.active = false; }
      });
    },
    async advance(operationId, phase) {
      if (!context.getStore()?.active || context.getStore()?.operationId !== operationId) {
        throw conflict("Plugin update intent is outside its active operation.");
      }
      await db.transaction(async tx => {
        const [row] = await tx.select().from(table).where(eq(table.id, operationId)).for("update");
        if (!row) throw conflict("Plugin update intent is unavailable.");
        const operation = decode(row);
        const phases = ["prepared", "committing", "committed", "activation_entered"];
        // Only Core's active operation can record its known-safe rollback
        // decision. Persist it before restoring old code so response loss in
        // that restore cannot be mistaken for an entered data migration.
        if (operation.kind !== "upgrade" || (phase !== "rollback_required"
          && (operation.phase === "rollback_required" || phases.indexOf(phase) < phases.indexOf(operation.phase)
            || phases.indexOf(phase) > phases.indexOf(operation.phase) + 1))) {
          throw conflict("Plugin update phase cannot be skipped or rewound.");
        }
        await tx.update(table).set({ snapshotJson: { ...row.snapshotJson, phase }, updatedAt: new Date() }).where(eq(table.id, operationId));
      });
    },
  };
  return {
    upgrade,
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
          if (operation.kind !== "uninstall" || operation.removeData !== removeData || !samePluginPackageArtifact(snapshot, operation.snapshot)) {
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
        const operation = decode(row);
        if (operation.kind !== "uninstall") throw new Error("Plugin removal intent has an invalid kind.");
        return operation;
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
      const owner = context.getStore();
      if (pending && !(owner?.active && owner.operationId === pending.id)) {
        throw conflict(pendingMessage, { code: "sps_plugin_package_recovery_required" });
      }
    },
    async complete(operationId, outcome) {
      await db.transaction(async tx => {
        const [row] = await tx.select().from(table).where(eq(table.id, operationId)).for("update");
        if (!row) throw conflict("Plugin package operation was not found.");
        if (row.completedAt) return;
        const operation = decode(row);
        if (operation.kind === "upgrade" && !outcome) throw new Error("Plugin update reconciliation outcome is required.");
        if (operation.kind === "upgrade" && outcome === "succeeded" && operation.phase !== "activation_entered") {
          throw new Error("Plugin update cannot succeed before entering activation.");
        }
        await tx.update(table).set({ activePluginId: null, completedAt: new Date(), updatedAt: new Date(),
          ...(operation.kind === "upgrade" ? { snapshotJson: { ...row.snapshotJson, phase: outcome } } : {}) })
          .where(and(eq(table.id, operationId), isNull(table.completedAt)));
      });
    },
  };
}
