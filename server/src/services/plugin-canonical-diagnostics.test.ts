import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "@paperclipai/shared";

const registry = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("./plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));

import { createPluginCanonicalDiagnostics, PLUGIN_DIAGNOSTIC_SCHEMA_V1 } from "./plugin-canonical-diagnostics.js";

const plugin = {
  id: "11111111-1111-4111-8111-111111111111",
  pluginKey: "sps.test-diagnostics",
  apiVersion: 1,
  status: "ready",
  lastError: null,
  updatedAt: new Date("2026-07-31T00:00:00.000Z"),
  manifestJson: {
    id: "sps.test-diagnostics",
    apiVersion: 1,
    capabilities: ["agent.tools.register", "mcp.client.connect"],
    tools: [{ toolKey: "inspect", displayName: "Inspect", description: "Inspect", inputSchema: {} }],
    jobs: [{ jobKey: "sync", displayName: "Sync", schedule: "0 * * * *" }],
    webhooks: [{ endpointKey: "updated", displayName: "Updated" }],
    apiRoutes: [{ routeKey: "status", method: "GET", path: "/status", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }],
    ui: { slots: [] },
    environmentDrivers: [{ driverKey: "local", displayName: "Local", schema: {} }],
  },
} as unknown as PluginRecord;

function createLifecycle() {
  const listeners = new Map<string, Array<(payload: any) => void>>();
  return {
    on: vi.fn((event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener])),
    off: vi.fn(),
    emit(event: string, payload: unknown) { for (const listener of listeners.get(event) ?? []) listener(payload); },
  };
}

describe("createPluginCanonicalDiagnostics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("matches the public v1 shape and turns declared runtime surfaces into safe facts", async () => {
    registry.getById.mockResolvedValue(plugin);
    const lifecycle = createLifecycle();
    const diagnostics = createPluginCanonicalDiagnostics({
      db: {} as never,
      lifecycle: lifecycle as never,
      workerManager: { getWorker: () => ({ diagnostics: () => ({ status: "running", consecutiveCrashes: 0, totalCrashes: 0, pendingRequests: 1 }) }) } as never,
      scheduler: { diagnostics: () => ({ running: true, activeJobCount: 2 }) } as never,
    });

    const snapshot = await diagnostics.snapshot(plugin.id, "host");
    expect(snapshot?.schemaVersion).toBe(PLUGIN_DIAGNOSTIC_SCHEMA_V1);
    expect(Object.keys(snapshot!.facts[0]!).sort()).toEqual([
      "category", "code", "details", "id", "level", "message", "occurredAt", "origin", "schemaVersion",
    ]);
    expect(snapshot?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "tool", code: "SPS_PLUGIN_TOOLS_DECLARED", origin: "core", level: "info" }),
      expect.objectContaining({ category: "job", code: "SPS_PLUGIN_JOBS_DECLARED" }),
      expect.objectContaining({ category: "event", code: "SPS_PLUGIN_EVENTS_DECLARED" }),
      expect.objectContaining({ category: "ui", code: "SPS_PLUGIN_UI_DECLARED" }),
      expect.objectContaining({ category: "connector", code: "SPS_PLUGIN_CONNECTORS_DECLARED" }),
      expect.objectContaining({ category: "mcp", code: "SPS_PLUGIN_MCP_CAPABILITY_DECLARED" }),
    ]));
    expect(snapshot?.runtime).toMatchObject({ worker: { running: true, pendingRequests: 1 }, scheduler: { running: true, activeJobCount: 2 } });
  });

  it("never exposes host-governed facts to members and reports only a safe visibility fact", async () => {
    registry.getById.mockResolvedValue(plugin);
    const diagnostics = createPluginCanonicalDiagnostics({
      db: {} as never,
      lifecycle: createLifecycle() as never,
      workerManager: { getWorker: () => undefined } as never,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    diagnostics.record({
      category: "migration",
      code: "SPS_PLUGIN_MIGRATION_APPLIED",
      level: "info",
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      message: "Applied C:\\private\\migration.sql with token=very-secret-value",
      details: { path: "C:\\private\\migration.sql", rawOutput: "should-not-appear", cyclic, finite: 1, invalid: Number.POSITIVE_INFINITY },
    });

    const member = await diagnostics.snapshot(plugin.id, "member");
    const host = await diagnostics.snapshot(plugin.id, "host");
    expect(member?.facts.some((item) => item.category === "migration")).toBe(false);
    expect(member?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "visibility", code: "SPS_PLUGIN_DIAGNOSTICS_REDACTED_FOR_MEMBER", details: { hiddenFactCount: 1 } }),
    ]));
    const migration = host?.facts.find((item) => item.category === "migration");
    expect(migration?.message).toBe("Plugin diagnostic details were redacted.");
    expect(migration?.details).toEqual({ finite: 1, invalid: "[redacted]" });
    expect(JSON.stringify(host)).not.toContain("private");
    expect(JSON.stringify(host)).not.toContain("very-secret-value");
  });

  it("records lifecycle events as uppercase stable v1 facts", async () => {
    registry.getById.mockResolvedValue(plugin);
    const lifecycle = createLifecycle();
    const diagnostics = createPluginCanonicalDiagnostics({ db: {} as never, lifecycle: lifecycle as never, workerManager: { getWorker: () => undefined } as never });
    lifecycle.emit("plugin.worker_started", { pluginId: plugin.id, pluginKey: plugin.pluginKey });
    const snapshot = await diagnostics.snapshot(plugin.id, "host");
    expect(snapshot?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ schemaVersion: PLUGIN_DIAGNOSTIC_SCHEMA_V1, category: "worker", code: "SPS_PLUGIN_WORKER_STARTED", level: "info" }),
    ]));
  });
});
