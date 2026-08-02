import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { pluginManagedRoutineDeclarationSchema, pluginManifestV1Schema, pluginUiSlotDeclarationSchema } from "./plugin.js";

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin manifest validators", () => {
  it("accepts existing-style plugins that do not request access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.compat-dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Compat Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "compat-dashboard",
            displayName: "Compat Dashboard",
            exportName: "CompatDashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

  it("accepts native SPS Shell, Dashboard, and Inbox declarations", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "sps.team-surface",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "SPS Team Surface",
      description: "Contributes workflow-neutral SPS workspace surfaces.",
      author: "SPS",
      categories: ["ui"],
      capabilities: [
        "ui.workspaceShell.provide",
        "ui.dashboard.contribute",
        "inbox.items.publish",
        "inbox.items.update",
        "inbox.actions.register",
      ],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
      ui: {
        workspaceShell: {
          id: "team",
          displayName: "Team",
          defaultRoute: "/projects",
          navigation: [{ id: "rooms", displayName: "Rooms", target: "/rooms", order: 10 }],
          dashboardPreset: [{ widgetId: "active-work", size: "medium", order: 10 }],
        },
        dashboardWidgets: [{
          id: "active-work",
          displayName: "Active work",
          exportName: "ActiveWorkWidget",
          sizes: ["small", "medium"],
          defaultSize: "medium",
          defaultOrder: 10,
          dataAction: "dashboard.active-work",
        }],
      },
      inbox: {
        actions: [{
          id: "open-report",
          displayName: "Open",
          action: "inbox.open-report",
        }],
      },
    });

    expect(parsed.ui?.workspaceShell?.id).toBe("team");
    expect(parsed.ui?.dashboardWidgets?.[0]?.defaultSize).toBe("medium");
    expect(parsed.inbox?.actions?.[0]?.id).toBe("open-report");
  });

  it("rejects duplicate Dashboard widget and Inbox action ids", () => {
    const base = {
      id: "sps.duplicate-surfaces",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Duplicate surfaces",
      description: "Duplicates must not create ambiguous Core surface keys.",
      author: "SPS",
      categories: ["ui"],
      capabilities: [
        "ui.dashboard.contribute",
        "inbox.actions.register",
      ],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
    };
    const widget = {
      id: "status",
      displayName: "Status",
      exportName: "StatusWidget",
      sizes: ["small"],
      defaultSize: "small",
      defaultOrder: 1,
      dataAction: "status.read",
    };
    const action = {
      id: "open",
      displayName: "Open",
      action: "status.open",
    };

    expect(() => pluginManifestV1Schema.parse({
      ...base,
      ui: { dashboardWidgets: [widget, widget] },
    })).toThrow("Dashboard widget ids must be unique");
    expect(() => pluginManifestV1Schema.parse({
      ...base,
      inbox: { actions: [action, action] },
    })).toThrow("Inbox action ids must be unique");
  });

  it("rejects native SPS surface declarations without matching capabilities", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "sps.invalid-surface",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Invalid surface",
      description: "Missing native surface capabilities.",
      author: "SPS",
      categories: ["ui"],
      capabilities: ["ui.page.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
      ui: {
        workspaceShell: { id: "invalid", displayName: "Invalid" },
        dashboardWidgets: [{
          id: "status",
          displayName: "Status",
          exportName: "StatusWidget",
          sizes: ["small"],
          defaultSize: "small",
          defaultOrder: 1,
          dataAction: "status.read",
        }],
      },
      inbox: {
        actions: [{ id: "retry", displayName: "Retry", action: "retry" }],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      "Capability 'ui.workspaceShell.provide' is required when ui.workspaceShell is declared",
    );
    expect(messages).toContain(
      "Capability 'ui.dashboard.contribute' is required when ui.dashboardWidgets are declared",
    );
    expect(messages).toContain(
      "Capability 'inbox.actions.register' is required when inbox.actions are declared",
    );
  });

  it("preserves a workflow-neutral SPS Core primitive declaration", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "sps.source-aware-plugin",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Source-aware plugin",
      description: "Uses Host-managed sources through opaque Core handles.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["agent.tools.register", "sps.workspaceSources.read", "sps.runtimes.read"],
      entrypoints: { worker: "./dist/worker.js" },
      sps: {
        contractVersion: "2.0",
        primitives: ["workspace.sources.metadata", "workspace.sources.route", "runtimes.list"],
      },
    });

    expect(parsed.sps).toEqual({
      contractVersion: "2.0",
      primitives: ["workspace.sources.metadata", "workspace.sources.route", "runtimes.list"],
    });
  });

  it("rejects a source route declaration without source metadata", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "sps.invalid-source-plugin",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Invalid source plugin",
      description: "Invalid Core primitive ordering.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "./dist/worker.js" },
      sps: {
        contractVersion: "2.0",
        primitives: ["workspace.sources.route"],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("workspace.sources.route requires"))).toBe(true);
  });

  it("rejects an SPS Core primitive without its matching runtime capability", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "sps.runtime-capability-gap",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Runtime capability gap",
      description: "Declares runtime discovery without requesting its Core capability.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "./dist/worker.js" },
      sps: {
        contractVersion: "2.0",
        primitives: ["runtimes.list"],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => (
      issue.message.includes("runtimes.list")
      && issue.message.includes("sps.runtimes.read")
    ))).toBe(true);
  });

  it("accepts sandbox provider template config bindings", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Template Provider",
      description: "Sandbox provider with captured template config binding.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "template-provider",
          kind: "sandbox_provider",
          displayName: "Template Provider",
          supportsTemplateCapture: true,
          templateRefKind: "provider_template",
          templateConfigBinding: {
            field: "templateId",
            unsetFields: ["image"],
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.environmentDrivers?.[0]?.templateConfigBinding).toEqual({
      field: "templateId",
      unsetFields: ["image"],
    });
  });

  it("accepts a scoped memory provider that exposes declared agent tools", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "sps.default-memory",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "SPS Default Memory",
      description: "Local first-party memory provider.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["memory.providers.register", "agent.tools.register"],
      entrypoints: { worker: "./dist/worker.js" },
      tools: [
        {
          name: "memory-search",
          displayName: "Memory Search",
          description: "Recall approved memory.",
          parametersSchema: { type: "object" },
        },
      ],
      memoryProvider: {
        providerKey: "sps-default",
        displayName: "SPS Default Memory",
        scopes: ["company", "project", "agent", "room", "task", "artifact", "user"],
        lifecycleEvents: ["room.checkpoint", "room.compacted", "task.completed"],
        recallToolName: "memory-search",
        defaultForNewCompanies: true,
      },
    });

    expect(parsed.memoryProvider?.providerKey).toBe("sps-default");
  });

  it("rejects a memory provider that names an undeclared recall tool", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "sps.invalid-memory",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Invalid Memory",
      description: "Invalid memory provider fixture.",
      author: "SPS",
      categories: ["automation"],
      capabilities: ["memory.providers.register", "agent.tools.register"],
      entrypoints: { worker: "./dist/worker.js" },
      memoryProvider: {
        providerKey: "invalid",
        displayName: "Invalid Memory",
        scopes: ["project"],
        recallToolName: "memory-search",
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("declared tool"))).toBe(true);
  });

  it("rejects template config bindings that replace provider identity", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.bad-template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Bad Template Provider",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "bad-template-provider",
          kind: "sandbox_provider",
          displayName: "Bad Template Provider",
          templateConfigBinding: {
            field: "provider",
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("provider key"))).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin UI slot validators", () => {
  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "settings-route-sidebar",
      displayName: "Settings Sidebar",
      exportName: "SettingsSidebar",
      routePath: "settings",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("accepts workspace entity types as detailTab targets", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "detailTab",
      id: "workspace-diff-viewer",
      displayName: "Diff",
      exportName: "WorkspaceDiffViewer",
      entityTypes: ["execution_workspace", "project_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace", "project_workspace"]);
  });

  it("accepts execution_workspace as a toolbarButton entityType", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "toolbarButton",
      id: "workspace-open-diff",
      displayName: "Open diff",
      exportName: "OpenWorkspaceDiffButton",
      entityTypes: ["execution_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace"]);
  });

  it("accepts company settings page slots with a non-core settings route", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "companySettingsPage",
      id: "permissions-settings",
      displayName: "Permissions",
      exportName: "PermissionsSettingsPage",
      routePath: "permissions",
    });

    expect(parsed.routePath).toBe("permissions");
  });

  it("prevents company settings page slots from shadowing core settings routes", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "instance-settings",
      displayName: "Instance",
      exportName: "InstanceSettingsPage",
      routePath: "instance",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});
