import { and, desc, eq } from "drizzle-orm";
import {
  companyMemoryLifecycleDeliveries,
  companyMemorySettings,
  type Db,
} from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  isDeclaredMemoryProviderTool,
  listReadyMemoryProviders,
  type MemoryProviderDescriptor,
} from "./memory-providers.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { logger } from "../middleware/logger.js";

export type MemoryProviderSelectionStatus = "enabled" | "disabled";

export interface CompanyMemoryProviderSelection {
  provider: MemoryProviderDescriptor | null;
  status: MemoryProviderSelectionStatus;
  source: "configured" | "default" | "disabled" | "unconfigured" | "unavailable";
  configuredProviderKey: string | null;
  configuredByUserId: string | null;
  lastDeliveryAt: string | null;
  lastError: string | null;
}

export interface MemoryLifecycleDelivery {
  id: string;
  providerPluginId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "failed" | "skipped";
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface CompanyMemoryProviderRuntime {
  listProviders(): Promise<MemoryProviderDescriptor[]>;
  getSelection(companyId: string): Promise<CompanyMemoryProviderSelection>;
  selectProvider(input: {
    companyId: string;
    providerKey: string | null;
    configuredByUserId: string | null;
  }): Promise<CompanyMemoryProviderSelection>;
  listDeliveries(companyId: string, limit?: number): Promise<MemoryLifecycleDelivery[]>;
  handleEvent(event: PluginEvent): Promise<void>;
  isSelectedProviderTool(input: { companyId: string; pluginDbId: string; toolName: string }): Promise<boolean>;
}

const MEMORY_PROVIDER_DELIVERY_FAILED = "MEMORY_PROVIDER_DELIVERY_FAILED";

function asIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toDelivery(row: typeof companyMemoryLifecycleDeliveries.$inferSelect): MemoryLifecycleDelivery {
  return {
    id: row.id,
    providerPluginId: row.providerPluginId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.status as MemoryLifecycleDelivery["status"],
    error: row.error,
    deliveredAt: asIso(row.deliveredAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function findConfiguredProvider(
  providers: MemoryProviderDescriptor[],
  stored: typeof companyMemorySettings.$inferSelect,
): MemoryProviderDescriptor | null {
  return providers.find((provider) => provider.pluginId === stored.providerPluginId)
    ?? providers.find((provider) => provider.providerKey === stored.providerKey)
    ?? null;
}

function defaultProvider(providers: MemoryProviderDescriptor[]): MemoryProviderDescriptor | null {
  return providers.find((provider) => provider.defaultForNewCompanies) ?? null;
}

export function resolveEffectiveMemoryProvider(input: {
  providers: MemoryProviderDescriptor[];
  stored: typeof companyMemorySettings.$inferSelect | null;
}): CompanyMemoryProviderSelection {
  const { providers, stored } = input;
  if (stored?.status === "disabled") {
    return {
      provider: null,
      status: "disabled",
      source: "disabled",
      configuredProviderKey: stored.providerKey,
      configuredByUserId: stored.configuredByUserId,
      lastDeliveryAt: asIso(stored.lastDeliveryAt),
      lastError: stored.lastError,
    };
  }
  const configured = stored ? findConfiguredProvider(providers, stored) : null;
  if (configured) {
    return {
      provider: configured,
      status: "enabled",
      source: "configured",
      configuredProviderKey: configured.providerKey,
      configuredByUserId: stored?.configuredByUserId ?? null,
      lastDeliveryAt: asIso(stored?.lastDeliveryAt ?? null),
      lastError: stored?.lastError ?? null,
    };
  }
  if (stored?.providerPluginId || stored?.providerKey) {
    return {
      provider: null,
      status: "enabled",
      source: "unavailable",
      configuredProviderKey: stored.providerKey,
      configuredByUserId: stored.configuredByUserId,
      lastDeliveryAt: asIso(stored.lastDeliveryAt),
      lastError: stored.lastError,
    };
  }
  const fallback = defaultProvider(providers);
  if (fallback) {
    return {
      provider: fallback,
      status: "enabled",
      source: "default",
      configuredProviderKey: fallback.providerKey,
      configuredByUserId: stored?.configuredByUserId ?? null,
      lastDeliveryAt: asIso(stored?.lastDeliveryAt ?? null),
      lastError: stored?.lastError ?? null,
    };
  }
  return {
    provider: null,
    status: "enabled",
    source: "unconfigured",
    configuredProviderKey: null,
    configuredByUserId: stored?.configuredByUserId ?? null,
    lastDeliveryAt: asIso(stored?.lastDeliveryAt ?? null),
    lastError: stored?.lastError ?? null,
  };
}

/**
 * Core-owned memory-provider control plane. Providers own data, recall, and
 * retention. Core owns provider selection and the durable lifecycle audit.
 */
export function createCompanyMemoryProviderRuntime(input: {
  db: Db;
  workerManager: PluginWorkerManager;
}): CompanyMemoryProviderRuntime {
  const registry = pluginRegistryService(input.db);
  const log = logger.child({ service: "memory-provider-runtime" });
  const listProviders = async () => listReadyMemoryProviders(await registry.listByStatus("ready"));
  const storedSelection = async (companyId: string) => input.db
    .select()
    .from(companyMemorySettings)
    .where(eq(companyMemorySettings.companyId, companyId))
    .then((rows) => rows[0] ?? null);
  const getSelection = async (companyId: string) => resolveEffectiveMemoryProvider({
    providers: await listProviders(),
    stored: await storedSelection(companyId),
  });

  return {
    listProviders,
    getSelection,

    async selectProvider({ companyId, providerKey, configuredByUserId }) {
      const providers = await listProviders();
      const provider = providerKey === null
        ? null
        : providers.find((candidate) => candidate.providerKey === providerKey) ?? null;
      if (providerKey !== null && !provider) {
        throw new Error(`Ready memory provider "${providerKey}" was not found.`);
      }
      const now = new Date();
      await input.db
        .insert(companyMemorySettings)
        .values({
          companyId,
          providerPluginId: provider?.pluginId ?? null,
          providerKey: provider?.providerKey ?? null,
          status: provider ? "enabled" : "disabled",
          configuredByUserId,
          lastError: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: companyMemorySettings.companyId,
          set: {
            providerPluginId: provider?.pluginId ?? null,
            providerKey: provider?.providerKey ?? null,
            status: provider ? "enabled" : "disabled",
            configuredByUserId,
            lastError: null,
            updatedAt: now,
          },
        });
      return getSelection(companyId);
    },

    async listDeliveries(companyId, limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
      const rows = await input.db
        .select()
        .from(companyMemoryLifecycleDeliveries)
        .where(eq(companyMemoryLifecycleDeliveries.companyId, companyId))
        .orderBy(desc(companyMemoryLifecycleDeliveries.createdAt))
        .limit(safeLimit);
      return rows.map(toDelivery);
    },

    async isSelectedProviderTool({ companyId, pluginDbId, toolName }) {
      const [providers, stored] = await Promise.all([listProviders(), storedSelection(companyId)]);
      const toolProvider = providers.find((provider) => provider.pluginId === pluginDbId);
      if (!toolProvider || !isDeclaredMemoryProviderTool(toolProvider, toolName)) return true;
      return resolveEffectiveMemoryProvider({ providers, stored }).provider?.pluginId === pluginDbId;
    },

    async handleEvent(event) {
      let selection = await getSelection(event.companyId);
      if (selection.source === "default" && selection.provider) {
        const now = new Date();
        await input.db.insert(companyMemorySettings).values({
          companyId: event.companyId,
          providerPluginId: selection.provider.pluginId,
          providerKey: selection.provider.providerKey,
          status: "enabled",
          configuredByUserId: null,
          updatedAt: now,
        }).onConflictDoNothing({ target: companyMemorySettings.companyId });
        // Re-read after the insert so a concurrent operator selection wins.
        selection = await getSelection(event.companyId);
      }
      const provider = selection.provider;
      if (!provider || selection.status !== "enabled") return;
      if (!provider.lifecycleEvents.includes(event.eventType as never)) return;

      const inserted = await input.db
        .insert(companyMemoryLifecycleDeliveries)
        .values({
          companyId: event.companyId,
          providerPluginId: provider.pluginId,
          eventId: event.eventId,
          eventType: event.eventType,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [companyMemoryLifecycleDeliveries.providerPluginId, companyMemoryLifecycleDeliveries.eventId],
        })
        .returning({ id: companyMemoryLifecycleDeliveries.id });
      const delivery = inserted[0];
      if (!delivery) return;

      try {
        await input.workerManager.call(provider.pluginId, "onEvent", { event }, 30_000);
        const now = new Date();
        await Promise.all([
          input.db.update(companyMemoryLifecycleDeliveries)
            .set({ status: "delivered", error: null, deliveredAt: now, updatedAt: now })
            .where(eq(companyMemoryLifecycleDeliveries.id, delivery.id)),
          input.db.update(companyMemorySettings)
            .set({ lastDeliveryAt: now, lastError: null, updatedAt: now })
            .where(and(
              eq(companyMemorySettings.companyId, event.companyId),
              eq(companyMemorySettings.providerPluginId, provider.pluginId),
            )),
        ]);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        await Promise.all([
          input.db.update(companyMemoryLifecycleDeliveries)
            .set({ status: "failed", error: MEMORY_PROVIDER_DELIVERY_FAILED, updatedAt: new Date() })
            .where(eq(companyMemoryLifecycleDeliveries.id, delivery.id)),
          input.db.update(companyMemorySettings)
            .set({ lastError: MEMORY_PROVIDER_DELIVERY_FAILED, updatedAt: new Date() })
            .where(and(
              eq(companyMemorySettings.companyId, event.companyId),
              eq(companyMemorySettings.providerPluginId, provider.pluginId),
            )),
        ]);
        log.warn({
          companyId: event.companyId,
          providerKey: provider.providerKey,
          eventType: event.eventType,
          errorName,
        }, "memory lifecycle delivery failed");
      }
    },
  };
}
