import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  pluginCompanySettings,
  plugins,
  spsDashboardLayoutItems,
  spsPluginInboxItems,
  spsPluginInboxUserStates,
  spsWorkspaceShellSettings,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { spsWorkspaceSurfaceService } from "../services/sps-workspace-surfaces.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function manifest(): PaperclipPluginManifestV1 {
  return {
    id: "sps.workspace-surfaces-test",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Workspace Surfaces Test",
    description: "Exercises native SPS workspace surfaces.",
    author: "SPS",
    categories: ["productivity"],
    capabilities: [
      "ui.workspaceShell.provide",
      "ui.dashboard.contribute",
      "inbox.items.publish",
      "inbox.items.update",
      "inbox.actions.register",
    ],
    entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui.js" },
    ui: {
      workspaceShell: {
        id: "team-shell",
        displayName: "Team Shell",
        navigation: [
          { id: "home", displayName: "Home", target: "/dashboard" },
        ],
      },
      dashboardWidgets: [
        {
          id: "work-summary",
          displayName: "Work summary",
          exportName: "WorkSummary",
          defaultSize: "medium",
          sizes: ["small", "medium", "large"],
          defaultOrder: 10,
          dataAction: "dashboard.summary",
        },
      ],
    },
    inbox: {
      actions: [
        {
          id: "open-review",
          displayName: "Open review",
          action: "review.open",
        },
      ],
    },
  };
}

describeEmbeddedPostgres("SPS workspace surfaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-workspace-surfaces-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(spsPluginInboxUserStates);
    await db.delete(spsPluginInboxItems);
    await db.delete(spsDashboardLayoutItems);
    await db.delete(spsWorkspaceShellSettings);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    const pluginManifest = manifest();
    await db.insert(companies).values({
      id: companyId,
      name: "SPS Workspace Test",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: pluginManifest.id,
      packageName: "@sps/workspace-surfaces-test",
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
    });
    return {
      companyId,
      pluginId,
      plugin: {
        id: pluginId,
        pluginKey: pluginManifest.id,
        packageName: "@sps/workspace-surfaces-test",
        version: pluginManifest.version,
        apiVersion: pluginManifest.apiVersion,
        categories: pluginManifest.categories,
        manifestJson: pluginManifest,
        status: "ready" as const,
        installOrder: null,
        packagePath: null,
        lastError: null,
        installedAt: new Date(),
        updatedAt: new Date(),
      },
    };
  }

  it("selects a Shell explicitly and falls back to Neutral after uninstall", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);

    expect(await surfaces.getShell(seeded.companyId)).toMatchObject({
      mode: "neutral",
      providerPluginId: null,
      fallbackReason: null,
    });

    expect(await surfaces.selectShell({
      companyId: seeded.companyId,
      userId: "owner-user",
      pluginId: seeded.pluginId,
    })).toMatchObject({
      mode: "plugin",
      providerPluginId: seeded.pluginId,
      providerPluginKey: seeded.plugin.pluginKey,
      shell: { id: "team-shell" },
    });

    await db.delete(plugins);
    expect(await surfaces.getShell(seeded.companyId)).toMatchObject({
      mode: "neutral",
      providerPluginId: null,
      providerPluginKey: seeded.plugin.pluginKey,
      fallbackReason: "Selected Shell plugin is no longer installed.",
    });
  });

  it("uses plugin widget declarations and stores a per-user layout", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);

    expect(await surfaces.listDashboard(seeded.companyId, "member-a")).toMatchObject([
      {
        pluginId: seeded.pluginId,
        widget: { id: "work-summary" },
        layout: { size: "medium", position: 10, source: "default" },
      },
    ]);

    expect(await surfaces.saveDashboardLayout({
      companyId: seeded.companyId,
      userId: "member-a",
      items: [{
        pluginId: seeded.pluginId,
        widgetId: "work-summary",
        size: "large",
        position: 2,
        collapsed: true,
      }],
    })).toMatchObject([
      {
        widget: { id: "work-summary" },
        layout: { size: "large", position: 2, collapsed: true, source: "user" },
      },
    ]);

    await expect(surfaces.saveDashboardLayout({
      companyId: seeded.companyId,
      userId: "member-a",
      items: [{
        pluginId: seeded.pluginId,
        widgetId: "work-summary",
        size: "full",
        position: 1,
      }],
    })).rejects.toThrow("does not support size");
  });

  it("keeps Inbox state user-specific and rejects undeclared actions", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);
    const item = await surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "review-42",
        category: "review",
        severity: "warning",
        title: "Review required",
        summary: "A plugin result is ready for review.",
        navigationTarget: "/projects/project-42",
        actionIds: ["open-review"],
      },
    });

    expect(await surfaces.listInbox({
      companyId: seeded.companyId,
      userId: "member-a",
    })).toMatchObject([{ id: item.id, unread: true }]);

    await surfaces.setInboxUserState({
      companyId: seeded.companyId,
      userId: "member-a",
      itemId: item.id,
      read: true,
      archived: true,
    });
    expect(await surfaces.listInbox({
      companyId: seeded.companyId,
      userId: "member-a",
    })).toEqual([]);
    expect(await surfaces.listInbox({
      companyId: seeded.companyId,
      userId: "member-b",
    })).toMatchObject([{ id: item.id, unread: true }]);

    expect(await surfaces.resolveInboxAction({
      companyId: seeded.companyId,
      userId: "member-b",
      itemId: item.id,
      actionId: "open-review",
    })).toMatchObject({
      item: { id: item.id },
      declaration: { action: "review.open" },
    });
    await expect(surfaces.resolveInboxAction({
      companyId: seeded.companyId,
      userId: "member-b",
      itemId: item.id,
      actionId: "not-attached",
    })).rejects.toThrow("not attached");
  });

  it("does not let the narrower Inbox update operation create a new item", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);
    const item = {
      externalId: "review-43",
      category: "review",
      title: "Review required",
      summary: "A plugin result is ready for review.",
    };

    await expect(surfaces.updateInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item,
    })).rejects.toThrow("Inbox item not found");

    await surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item,
    });
    await expect(surfaces.updateInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: { ...item, title: "Review updated" },
    })).resolves.toMatchObject({ title: "Review updated" });
  });

  it("preserves summaries through soft and hard unloads, then deletes hard-purge orphans by plugin key", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);
    const item = await surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "keep-until-host-deletes",
        category: "report",
        title: "Keep this summary",
        summary: "The Host has not chosen to delete this history.",
      },
    });

    // A normal lifecycle unload changes plugin state but does not remove the
    // operational history by default.
    await db.update(plugins)
      .set({ status: "uninstalled" })
      .where(eq(plugins.id, seeded.pluginId));
    expect(await surfaces.listInbox({ companyId: seeded.companyId, userId: "owner-user" }))
      .toMatchObject([{ id: item.id }]);

    // A hard purge clears the FK. The explicit cleanup must still identify
    // every summary through the immutable plugin key.
    await db.delete(plugins).where(eq(plugins.id, seeded.pluginId));
    const [orphan] = await db.select({ sourcePluginId: spsPluginInboxItems.sourcePluginId })
      .from(spsPluginInboxItems)
      .where(eq(spsPluginInboxItems.id, item.id));
    expect(orphan?.sourcePluginId).toBeNull();
    expect(await surfaces.listInbox({ companyId: seeded.companyId, userId: "owner-user" }))
      .toMatchObject([{ id: item.id }]);

    expect(await surfaces.deleteInboxSummariesBySourcePluginKey(seeded.plugin.pluginKey)).toBe(1);
    expect(await db.select().from(spsPluginInboxItems)).toEqual([]);
    expect(await db.select().from(spsPluginInboxUserStates)).toEqual([]);
  });

  it("refuses unsafe Inbox navigation and actions not declared by the plugin", async () => {
    const seeded = await seed();
    const surfaces = spsWorkspaceSurfaceService(db);

    await expect(surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "unsafe-route",
        category: "review",
        title: "Unsafe",
        summary: "Unsafe route",
        navigationTarget: "https://example.com",
      },
    })).rejects.toThrow("safe absolute SPS route");

    await expect(surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "unknown-action",
        category: "review",
        title: "Unknown action",
        summary: "Unknown action",
        actionIds: ["delete-everything"],
      },
    })).rejects.toThrow("is not declared");

    await expect(surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "oversized-route",
        category: "review",
        title: "Oversized route",
        summary: "Oversized route",
        navigationTarget: `/${"x".repeat(500)}`,
      },
    })).rejects.toThrow("must be between 1 and 500 characters");

    await expect(surfaces.publishInboxItem({
      companyId: seeded.companyId,
      plugin: seeded.plugin,
      item: {
        externalId: "oversized-reference",
        category: "review",
        title: "Oversized reference",
        summary: "Oversized reference",
        opaqueReference: { payload: "x".repeat(32_769) },
      },
    })).rejects.toThrow("must not exceed 32 KiB");
  });
});
