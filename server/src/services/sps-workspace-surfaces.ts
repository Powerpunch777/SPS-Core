import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  spsDashboardLayoutItems,
  spsPluginInboxItems,
  spsPluginInboxUserStates,
  spsWorkspaceShellSettings,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginDashboardWidgetDeclaration,
  PluginRecord,
  PluginWorkspaceShellDeclaration,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { resolvePluginCompanyActivation } from "./plugin-company-activation.js";
import { pluginRegistryService } from "./plugin-registry.js";

export type SpsWorkspaceShellState = {
  mode: "neutral" | "plugin";
  providerPluginId: string | null;
  providerPluginKey: string | null;
  shell: PluginWorkspaceShellDeclaration | null;
  fallbackReason: string | null;
};

export type SpsDashboardWidget = {
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  widget: PluginDashboardWidgetDeclaration;
  layout: {
    size: "small" | "medium" | "large" | "full";
    position: number;
    collapsed: boolean;
    source: "user" | "default";
  };
};

export type SpsPluginInboxItemInput = {
  externalId: string;
  targetUserId?: string | null;
  category: string;
  severity?: "info" | "success" | "warning" | "error";
  title: string;
  summary: string;
  navigationTarget?: string | null;
  actionIds?: string[];
  opaqueReference?: Record<string, unknown>;
};

function hasCapability(manifest: PaperclipPluginManifestV1, capability: string): boolean {
  return manifest.capabilities.some((entry) => entry === capability);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw badRequest(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || value.length > maxLength) {
    throw badRequest(`${label} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function safeNavigationTarget(target: unknown): string | null {
  if (target === null || target === undefined) return null;
  const normalized = boundedString(target, "Inbox navigationTarget", 500);
  if (
    !normalized.startsWith("/")
    || normalized.startsWith("//")
    || normalized.includes("..")
  ) {
    throw badRequest("Inbox navigationTarget must be a safe absolute SPS route");
  }
  return normalized;
}

function validateOpaqueReference(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw badRequest("Inbox opaqueReference must be a JSON object");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw badRequest("Inbox opaqueReference must be JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw badRequest("Inbox opaqueReference must not exceed 32 KiB");
  }
  return value;
}

function validateTargetUserId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, "Inbox targetUserId", 200);
}

function validateSeverity(value: unknown): "info" | "success" | "warning" | "error" {
  if (value === undefined) return "info";
  if (value !== "info" && value !== "success" && value !== "warning" && value !== "error") {
    throw badRequest("Inbox severity is invalid");
  }
  return value;
}

function validateActionIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw badRequest("Inbox actionIds must be an array of strings");
  }
  return [...new Set(value)];
}

function validateInboxInput(
  manifest: PaperclipPluginManifestV1,
  input: SpsPluginInboxItemInput,
): SpsPluginInboxItemInput {
  const externalId = boundedString(input.externalId, "Inbox externalId", 200);
  const category = boundedString(input.category, "Inbox category", 100);
  const title = boundedString(input.title, "Inbox title", 200);
  const summary = boundedString(input.summary, "Inbox summary", 2_000);
  const navigationTarget = safeNavigationTarget(input.navigationTarget);
  const actionIds = validateActionIds(input.actionIds);
  const declaredActions = new Set((manifest.inbox?.actions ?? []).map((action) => action.id));
  for (const actionId of actionIds) {
    if (!declaredActions.has(actionId)) {
      throw badRequest(`Inbox action '${actionId}' is not declared by plugin '${manifest.id}'`);
    }
  }
  return {
    ...input,
    externalId,
    targetUserId: validateTargetUserId(input.targetUserId),
    category,
    severity: validateSeverity(input.severity),
    title,
    summary,
    navigationTarget,
    actionIds,
    opaqueReference: validateOpaqueReference(input.opaqueReference),
  };
}

export function spsWorkspaceSurfaceService(db: Db) {
  const registry = pluginRegistryService(db);

  async function enabledPlugin(plugin: PluginRecord, companyId: string): Promise<boolean> {
    return plugin.status === "ready"
      && (await resolvePluginCompanyActivation(registry, plugin, companyId)).enabled;
  }

  async function listShellProviders(companyId: string) {
    const ready = await registry.listByStatus("ready");
    const candidates = await Promise.all(ready.map(async (plugin) => {
      const shell = plugin.manifestJson.ui?.workspaceShell;
      if (
        !shell
        || !hasCapability(plugin.manifestJson, "ui.workspaceShell.provide")
        || !await enabledPlugin(plugin, companyId)
      ) return null;
      return {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        pluginDisplayName: plugin.manifestJson.displayName,
        shell,
      };
    }));
    return candidates
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => (
        a.pluginDisplayName.localeCompare(b.pluginDisplayName)
        || a.pluginKey.localeCompare(b.pluginKey)
      ));
  }

  async function getShell(companyId: string): Promise<SpsWorkspaceShellState> {
    const [setting] = await db
      .select()
      .from(spsWorkspaceShellSettings)
      .where(eq(spsWorkspaceShellSettings.companyId, companyId))
      .limit(1);
    if (!setting?.providerPluginId) {
      const fallbackReason = setting?.providerPluginKey
        ? setting.fallbackReason ?? "Selected Shell plugin is no longer installed."
        : setting?.fallbackReason ?? null;
      if (setting && setting.fallbackReason !== fallbackReason) {
        await db.update(spsWorkspaceShellSettings)
          .set({ fallbackReason, updatedAt: new Date() })
          .where(eq(spsWorkspaceShellSettings.id, setting.id));
      }
      return {
        mode: "neutral",
        providerPluginId: null,
        providerPluginKey: setting?.providerPluginKey ?? null,
        shell: null,
        fallbackReason,
      };
    }

    const plugin = await registry.getById(setting.providerPluginId);
    const shell = plugin?.manifestJson.ui?.workspaceShell;
    let fallbackReason: string | null = null;
    if (!plugin) fallbackReason = "Selected Shell plugin is no longer installed.";
    else if (!await enabledPlugin(plugin, companyId)) fallbackReason = "Selected Shell plugin is not active.";
    else if (!hasCapability(plugin.manifestJson, "ui.workspaceShell.provide")) {
      fallbackReason = "Selected plugin no longer declares the Shell capability.";
    } else if (!shell || shell.id !== setting.shellId) {
      fallbackReason = "Selected Shell declaration is no longer available.";
    }

    if (fallbackReason || !plugin || !shell) {
      if (setting.fallbackReason !== fallbackReason) {
        await db.update(spsWorkspaceShellSettings)
          .set({ fallbackReason, updatedAt: new Date() })
          .where(eq(spsWorkspaceShellSettings.id, setting.id));
      }
      return {
        mode: "neutral",
        providerPluginId: setting.providerPluginId,
        providerPluginKey: setting.providerPluginKey,
        shell: null,
        fallbackReason,
      };
    }

    return {
      mode: "plugin",
      providerPluginId: plugin.id,
      providerPluginKey: plugin.pluginKey,
      shell,
      fallbackReason: null,
    };
  }

  async function selectShell(input: {
    companyId: string;
    userId: string;
    pluginId: string | null;
    shellId?: string | null;
  }): Promise<SpsWorkspaceShellState> {
    if (input.pluginId === null) {
      await db.insert(spsWorkspaceShellSettings).values({
        companyId: input.companyId,
        providerPluginId: null,
        providerPluginKey: null,
        shellId: null,
        selectedByUserId: input.userId,
        fallbackReason: null,
      }).onConflictDoUpdate({
        target: spsWorkspaceShellSettings.companyId,
        set: {
          providerPluginId: null,
          providerPluginKey: null,
          shellId: null,
          selectedByUserId: input.userId,
          fallbackReason: null,
          updatedAt: new Date(),
        },
      });
      return getShell(input.companyId);
    }

    const plugin = await registry.getById(input.pluginId);
    if (!plugin || !await enabledPlugin(plugin, input.companyId)) {
      throw notFound("Active Shell provider plugin not found");
    }
    const shell = plugin.manifestJson.ui?.workspaceShell;
    if (!shell || !hasCapability(plugin.manifestJson, "ui.workspaceShell.provide")) {
      throw badRequest("Plugin does not provide an SPS Workspace Shell");
    }
    if (input.shellId && input.shellId !== shell.id) {
      throw badRequest("Requested Shell id does not match the plugin declaration");
    }

    await db.insert(spsWorkspaceShellSettings).values({
      companyId: input.companyId,
      providerPluginId: plugin.id,
      providerPluginKey: plugin.pluginKey,
      shellId: shell.id,
      selectedByUserId: input.userId,
      fallbackReason: null,
    }).onConflictDoUpdate({
      target: spsWorkspaceShellSettings.companyId,
      set: {
        providerPluginId: plugin.id,
        providerPluginKey: plugin.pluginKey,
        shellId: shell.id,
        selectedByUserId: input.userId,
        fallbackReason: null,
        updatedAt: new Date(),
      },
    });
    return getShell(input.companyId);
  }

  async function listDashboard(companyId: string, userId: string): Promise<SpsDashboardWidget[]> {
    const [ready, layouts] = await Promise.all([
      registry.listByStatus("ready"),
      db.select().from(spsDashboardLayoutItems).where(and(
        eq(spsDashboardLayoutItems.companyId, companyId),
        eq(spsDashboardLayoutItems.userId, userId),
      )),
    ]);
    const layoutMap = new Map(layouts.map((layout) => [
      `${layout.pluginId}:${layout.widgetId}`,
      layout,
    ]));
    const enabled = await Promise.all(ready.map(async (plugin) => (
      await enabledPlugin(plugin, companyId) ? plugin : null
    )));
    const shell = layouts.length === 0 ? await getShell(companyId) : null;
    const shellPreset = new Map(
      (shell?.shell?.dashboardPreset ?? []).map((item) => [
        `${item.pluginKey ?? shell?.providerPluginKey ?? ""}:${item.widgetId}`,
        item,
      ]),
    );
    const widgets: SpsDashboardWidget[] = [];
    for (const plugin of enabled) {
      if (!plugin || !hasCapability(plugin.manifestJson, "ui.dashboard.contribute")) continue;
      for (const widget of plugin.manifestJson.ui?.dashboardWidgets ?? []) {
        const saved = layoutMap.get(`${plugin.id}:${widget.id}`);
        const preset = shellPreset.get(`${plugin.pluginKey}:${widget.id}`);
        const presetSize = preset && widget.sizes.includes(preset.size)
          ? preset.size
          : widget.defaultSize;
        widgets.push({
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          pluginDisplayName: plugin.manifestJson.displayName,
          widget,
          layout: saved ? {
            size: saved.size,
            position: saved.position,
            collapsed: saved.collapsed,
            source: "user",
          } : {
            size: presetSize,
            position: preset?.order ?? widget.defaultOrder,
            collapsed: false,
            source: "default",
          },
        });
      }
    }
    return widgets.sort((a, b) => (
      a.layout.position - b.layout.position
      || a.widget.displayName.localeCompare(b.widget.displayName)
      || a.pluginKey.localeCompare(b.pluginKey)
    ));
  }

  async function saveDashboardLayout(input: {
    companyId: string;
    userId: string;
    items: Array<{
      pluginId: string;
      widgetId: string;
      size: "small" | "medium" | "large" | "full";
      position: number;
      collapsed?: boolean;
    }>;
  }): Promise<SpsDashboardWidget[]> {
    const available = await listDashboard(input.companyId, input.userId);
    const allowed = new Map(available.map((entry) => [
      `${entry.pluginId}:${entry.widget.id}`,
      entry.widget,
    ]));
    const keys = new Set<string>();
    for (const item of input.items) {
      const key = `${item.pluginId}:${item.widgetId}`;
      const declaration = allowed.get(key);
      if (!declaration) throw badRequest(`Dashboard widget '${key}' is not available`);
      if (!declaration.sizes.includes(item.size)) {
        throw badRequest(`Dashboard widget '${key}' does not support size '${item.size}'`);
      }
      if (keys.has(key)) throw badRequest(`Dashboard widget '${key}' appears more than once`);
      keys.add(key);
    }

    await db.transaction(async (tx) => {
      await tx.delete(spsDashboardLayoutItems).where(and(
        eq(spsDashboardLayoutItems.companyId, input.companyId),
        eq(spsDashboardLayoutItems.userId, input.userId),
      ));
      if (input.items.length > 0) {
        await tx.insert(spsDashboardLayoutItems).values(input.items.map((item) => ({
          companyId: input.companyId,
          userId: input.userId,
          pluginId: item.pluginId,
          widgetId: item.widgetId,
          size: item.size,
          position: item.position,
          collapsed: item.collapsed ?? false,
        })));
      }
    });
    return listDashboard(input.companyId, input.userId);
  }

  async function publishInboxItem(input: {
    companyId: string;
    plugin: PluginRecord;
    item: SpsPluginInboxItemInput;
  }) {
    const item = validateInboxInput(input.plugin.manifestJson, input.item);
    const [record] = await db.insert(spsPluginInboxItems).values({
      companyId: input.companyId,
      sourcePluginId: input.plugin.id,
      sourcePluginKey: input.plugin.pluginKey,
      externalId: item.externalId,
      targetUserId: item.targetUserId ?? null,
      category: item.category,
      severity: item.severity ?? "info",
      title: item.title,
      summary: item.summary,
      navigationTarget: item.navigationTarget ?? null,
      actionIds: item.actionIds ?? [],
      opaqueReference: item.opaqueReference ?? {},
      withdrawnAt: null,
    }).onConflictDoUpdate({
      target: [
        spsPluginInboxItems.companyId,
        spsPluginInboxItems.sourcePluginKey,
        spsPluginInboxItems.externalId,
      ],
      set: {
        sourcePluginId: input.plugin.id,
        targetUserId: item.targetUserId ?? null,
        category: item.category,
        severity: item.severity ?? "info",
        title: item.title,
        summary: item.summary,
        navigationTarget: item.navigationTarget ?? null,
        actionIds: item.actionIds ?? [],
        opaqueReference: item.opaqueReference ?? {},
        withdrawnAt: null,
        updatedAt: new Date(),
      },
    }).returning();
    return record;
  }

  async function updateInboxItem(input: {
    companyId: string;
    plugin: PluginRecord;
    item: SpsPluginInboxItemInput;
  }) {
    const item = validateInboxInput(input.plugin.manifestJson, input.item);
    const [record] = await db.update(spsPluginInboxItems)
      .set({
        sourcePluginId: input.plugin.id,
        targetUserId: item.targetUserId ?? null,
        category: item.category,
        severity: item.severity ?? "info",
        title: item.title,
        summary: item.summary,
        navigationTarget: item.navigationTarget ?? null,
        actionIds: item.actionIds ?? [],
        opaqueReference: item.opaqueReference ?? {},
        withdrawnAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(spsPluginInboxItems.companyId, input.companyId),
        eq(spsPluginInboxItems.sourcePluginKey, input.plugin.pluginKey),
        eq(spsPluginInboxItems.externalId, item.externalId),
      ))
      .returning();
    if (!record) throw notFound("Inbox item not found");
    return record;
  }

  async function withdrawInboxItem(input: {
    companyId: string;
    pluginKey: string;
    externalId: string;
  }) {
    const [record] = await db.update(spsPluginInboxItems)
      .set({ withdrawnAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(spsPluginInboxItems.companyId, input.companyId),
        eq(spsPluginInboxItems.sourcePluginKey, input.pluginKey),
        eq(spsPluginInboxItems.externalId, input.externalId),
      ))
      .returning();
    if (!record) throw notFound("Inbox item not found");
    return record;
  }

  async function listInbox(input: {
    companyId: string;
    userId: string;
    includeArchived?: boolean;
  }) {
    const rows = await db.select({
      item: spsPluginInboxItems,
      readAt: spsPluginInboxUserStates.readAt,
      archivedAt: spsPluginInboxUserStates.archivedAt,
    })
      .from(spsPluginInboxItems)
      .leftJoin(spsPluginInboxUserStates, and(
        eq(spsPluginInboxUserStates.itemId, spsPluginInboxItems.id),
        eq(spsPluginInboxUserStates.userId, input.userId),
      ))
      .where(and(
        eq(spsPluginInboxItems.companyId, input.companyId),
        isNull(spsPluginInboxItems.withdrawnAt),
        or(
          isNull(spsPluginInboxItems.targetUserId),
          eq(spsPluginInboxItems.targetUserId, input.userId),
        ),
        input.includeArchived ? undefined : isNull(spsPluginInboxUserStates.archivedAt),
      ))
      .orderBy(desc(spsPluginInboxItems.updatedAt), asc(spsPluginInboxItems.id));
    const pluginIds = [...new Set(rows
      .map((row) => row.item.sourcePluginId)
      .filter((pluginId): pluginId is string => Boolean(pluginId)))];
    const resolvedPlugins = await Promise.all(pluginIds.map(async (pluginId) => {
      const plugin = await registry.getById(pluginId);
      if (!plugin) return [pluginId, null] as const;
      return [
        pluginId,
        {
          plugin,
          active: await enabledPlugin(plugin, input.companyId),
        },
      ] as const;
    }));
    const pluginMap = new Map(resolvedPlugins);
    return rows.map((row) => {
      const source = row.item.sourcePluginId
        ? pluginMap.get(row.item.sourcePluginId) ?? null
        : null;
      const declaredActions = source?.plugin.manifestJson.inbox?.actions ?? [];
      return {
        ...row.item,
        sourcePluginDisplayName:
          source?.plugin.manifestJson.displayName ?? row.item.sourcePluginKey,
        actions: source?.active
          ? row.item.actionIds
            .map((actionId) => declaredActions.find((action) => action.id === actionId))
            .filter((action): action is NonNullable<typeof action> => Boolean(action))
          : [],
        unread: row.readAt === null,
        readAt: row.readAt,
        archivedAt: row.archivedAt,
      };
    });
  }

  async function setInboxUserState(input: {
    companyId: string;
    userId: string;
    itemId: string;
    read?: boolean;
    archived?: boolean;
  }) {
    const [item] = await db.select().from(spsPluginInboxItems).where(and(
      eq(spsPluginInboxItems.id, input.itemId),
      eq(spsPluginInboxItems.companyId, input.companyId),
    )).limit(1);
    if (!item) throw notFound("Inbox item not found");
    if (item.targetUserId && item.targetUserId !== input.userId) {
      throw notFound("Inbox item not found");
    }
    const now = new Date();
    const [state] = await db.insert(spsPluginInboxUserStates).values({
      companyId: input.companyId,
      itemId: input.itemId,
      userId: input.userId,
      readAt: input.read === undefined ? null : input.read ? now : null,
      archivedAt: input.archived === undefined ? null : input.archived ? now : null,
    }).onConflictDoUpdate({
      target: [spsPluginInboxUserStates.itemId, spsPluginInboxUserStates.userId],
      set: {
        ...(input.read !== undefined ? { readAt: input.read ? now : null } : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? now : null } : {}),
        updatedAt: now,
      },
    }).returning();
    return state;
  }

  async function resolveInboxAction(input: {
    companyId: string;
    userId: string;
    itemId: string;
    actionId: string;
  }) {
    const [item] = await db.select().from(spsPluginInboxItems).where(and(
      eq(spsPluginInboxItems.id, input.itemId),
      eq(spsPluginInboxItems.companyId, input.companyId),
      isNull(spsPluginInboxItems.withdrawnAt),
      or(
        isNull(spsPluginInboxItems.targetUserId),
        eq(spsPluginInboxItems.targetUserId, input.userId),
      ),
    )).limit(1);
    if (!item || !item.sourcePluginId) throw notFound("Active Inbox source plugin not found");
    if (!item.actionIds.includes(input.actionId)) throw badRequest("Inbox action is not attached to this item");
    const plugin = await registry.getById(item.sourcePluginId);
    if (!plugin || !await enabledPlugin(plugin, input.companyId)) {
      throw notFound("Active Inbox source plugin not found");
    }
    const declaration = plugin.manifestJson.inbox?.actions?.find((action) => action.id === input.actionId);
    if (!declaration || !hasCapability(plugin.manifestJson, "inbox.actions.register")) {
      throw badRequest("Inbox action is no longer declared by the source plugin");
    }
    return { item, plugin, declaration };
  }

  return {
    listShellProviders,
    getShell,
    selectShell,
    listDashboard,
    saveDashboardLayout,
    publishInboxItem,
    updateInboxItem,
    withdrawInboxItem,
    listInbox,
    setInboxUserState,
    resolveInboxAction,
  };
}
