/**
 * Canonical, Core-owned plugin diagnostic facts.
 *
 * This is evidence for product shells, not a log transport. It deliberately
 * shares the public SDK `sps-plugin-diagnostic/v1` event shape while retaining
 * host-governed operational facts inside Core until a Host requests them.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type {
  PluginDiagnosticCategoryV1,
  PluginDiagnosticFactV1,
  PluginDiagnosticLevelV1,
  PluginDiagnosticValueV1,
  PluginDiagnosticsSnapshotV1,
  PluginRecord,
} from "@paperclipai/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginLifecycleEvents, PluginLifecycleManager } from "./plugin-lifecycle.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";

export const PLUGIN_DIAGNOSTIC_SCHEMA_V1 = "sps-plugin-diagnostic/v1" as const;
const MAX_FACTS_PER_PLUGIN = 100;
const MAX_DETAILS = 32;
const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_STRING_LENGTH = 512;
const MAX_EVENT_BYTES = 16 * 1024;
const SAFE_DETAIL_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,119}$/;
const HOST_ONLY_CATEGORIES = new Set<PluginDiagnosticCategoryV1>(["migration", "backup", "rollback"]);
const SENSITIVE_KEY = /(?:secret|token|password|credential|authorization|cookie|private.?key|api.?key|access.?key|client.?key|bearer|output|stdout|stderr|command|path|directory|folder|file)/i;
const SECRET_VALUE = /(?:-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|pk|rk|ghp|github_pat|xox[abprs]|AIza)[_-]?[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|credential|secret)\s*[:=])/i;
const LOCAL_PATH = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|tmp|etc|opt|mnt|private|Volumes|root|ProgramData|Windows)(?:[\\/]|$)|~[\\/])/i;

export type PluginDiagnosticAudience = "host" | "member";
type CoreOrigin = "core" | "plugin";
type FactInput = {
  origin?: CoreOrigin;
  level: PluginDiagnosticLevelV1;
  category: PluginDiagnosticCategoryV1;
  code: string;
  pluginId: string;
  pluginKey?: string;
  message: string;
  details?: Record<string, unknown>;
};

const INVALID_DETAIL = Symbol("invalid-plugin-diagnostic-detail");
type NormalizedDetail = PluginDiagnosticValueV1 | typeof INVALID_DETAIL;

export interface PluginCanonicalDiagnostics {
  record(input: FactInput): void;
  snapshot(pluginId: string, audience: PluginDiagnosticAudience): Promise<PluginDiagnosticsSnapshotV1 | null>;
  dispose(): void;
}

function safeText(value: unknown, fallback: string, max = MAX_DETAIL_STRING_LENGTH): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || SECRET_VALUE.test(normalized) || LOCAL_PATH.test(normalized) || /^file:/i.test(normalized)) return fallback;
  return normalized.slice(0, max);
}

function safeDetails(value: Record<string, unknown> | undefined): Record<string, PluginDiagnosticValueV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown, depth: number): NormalizedDetail => {
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : "[redacted]";
    if (typeof entry === "string") return safeText(entry, "[redacted]");
    if (typeof entry !== "object" || depth >= MAX_DETAIL_DEPTH || seen.has(entry)) return INVALID_DETAIL;
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        const result: PluginDiagnosticValueV1[] = [];
        for (let index = 0; index < Math.min(entry.length, MAX_DETAILS); index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (!descriptor || !("value" in descriptor)) return INVALID_DETAIL;
          const item = normalize(descriptor.value, depth + 1);
          if (item === INVALID_DETAIL) return INVALID_DETAIL;
          result.push(item);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) return INVALID_DETAIL;
      const result: Record<string, PluginDiagnosticValueV1> = {};
      const keys = Reflect.ownKeys(entry);
      if (keys.some((key) => typeof key !== "string")) return INVALID_DETAIL;
      for (const key of keys.slice(0, MAX_DETAILS) as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        if (!descriptor || !("value" in descriptor)) return INVALID_DETAIL;
        if (!SAFE_DETAIL_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
        const child = normalize(descriptor.value, depth + 1);
        if (child === INVALID_DETAIL) {
          if (depth === 0) continue;
          return INVALID_DETAIL;
        }
        result[key] = child;
      }
      return result;
    } finally {
      seen.delete(entry);
    }
  };
  const normalized = normalize(value, 0);
  return normalized !== INVALID_DETAIL && normalized && !Array.isArray(normalized) && typeof normalized === "object" ? normalized : {};
}

function stableCode(code: string): string {
  return SAFE_CODE.test(code) ? code : "SPS_PLUGIN_DIAGNOSTIC_INVALID";
}

function fact(input: FactInput): PluginDiagnosticFactV1 {
  const result: PluginDiagnosticFactV1 = {
    schemaVersion: PLUGIN_DIAGNOSTIC_SCHEMA_V1,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    origin: input.origin ?? "core",
    category: input.category,
    level: input.level,
    code: stableCode(input.code),
    message: safeText(input.message, "Plugin diagnostic details were redacted.", 240),
    details: safeDetails(input.details),
  };
  // Defensive size bound should a future detail type become wider.
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_EVENT_BYTES
    ? result
    : { ...result, message: "Plugin diagnostic details were redacted.", details: {} };
}

function derivedFact(input: FactInput, id: string, occurredAt: string): PluginDiagnosticFactV1 {
  return { ...fact(input), id, occurredAt };
}

function declaredFacts(plugin: PluginRecord): PluginDiagnosticFactV1[] {
  const manifest = plugin.manifestJson;
  const timestamp = plugin.updatedAt.toISOString();
  const base = { pluginId: plugin.id, pluginKey: plugin.pluginKey };
  const count = (items: unknown[] | undefined) => items?.length ?? 0;
  const result: PluginDiagnosticFactV1[] = [
    derivedFact({ ...base, level: "info", category: "manifest", code: "SPS_PLUGIN_MANIFEST_PRESENT", message: "Installed manifest is available.", details: { apiVersion: plugin.apiVersion } }, `manifest-${plugin.id}`, timestamp),
    derivedFact({ ...base, level: plugin.status === "error" ? "error" : "info", category: "compatibility", code: plugin.status === "error" ? "SPS_PLUGIN_LIFECYCLE_ERROR" : "SPS_PLUGIN_LIFECYCLE_STATUS", message: plugin.status === "error" ? "Plugin lifecycle is in an error state." : "Plugin lifecycle status is available.", details: { status: plugin.status } }, `lifecycle-${plugin.id}`, timestamp),
  ];
  if (plugin.lastError) result.push(derivedFact({ ...base, level: "warn", category: "event", code: "SPS_PLUGIN_LAST_ERROR_REDACTED", message: "The plugin recorded a recent lifecycle error.", details: {} }, `last-error-${plugin.id}`, timestamp));
  for (const [index, capability] of manifest.capabilities.entries()) result.push(derivedFact({ ...base, level: "info", category: "capability", code: "SPS_PLUGIN_CAPABILITY_DECLARED", message: "Plugin capability is declared by the installed manifest.", details: { capability } }, `capability-${plugin.id}-${index}`, timestamp));
  if (count(manifest.tools) > 0) result.push(derivedFact({ ...base, level: "info", category: "tool", code: "SPS_PLUGIN_TOOLS_DECLARED", message: "Plugin tools are declared by the installed manifest.", details: { count: count(manifest.tools) } }, `tools-${plugin.id}`, timestamp));
  if (count(manifest.jobs) > 0) result.push(derivedFact({ ...base, level: "info", category: "job", code: "SPS_PLUGIN_JOBS_DECLARED", message: "Plugin scheduled jobs are declared by the installed manifest.", details: { count: count(manifest.jobs) } }, `jobs-${plugin.id}`, timestamp));
  if (count(manifest.webhooks) + count(manifest.apiRoutes) > 0) result.push(derivedFact({ ...base, level: "info", category: "event", code: "SPS_PLUGIN_EVENTS_DECLARED", message: "Plugin inbound event surfaces are declared by the installed manifest.", details: { webhooks: count(manifest.webhooks), apiRoutes: count(manifest.apiRoutes) } }, `events-${plugin.id}`, timestamp));
  if (manifest.ui || manifest.launchers?.length) result.push(derivedFact({ ...base, level: "info", category: "ui", code: "SPS_PLUGIN_UI_DECLARED", message: "Plugin UI contributions are declared by the installed manifest.", details: { slots: count(manifest.ui?.slots), launchers: count(manifest.ui?.launchers) + count(manifest.launchers) } }, `ui-${plugin.id}`, timestamp));
  if (count(manifest.environmentDrivers) + count(manifest.objectReferences) > 0) result.push(derivedFact({ ...base, level: "info", category: "connector", code: "SPS_PLUGIN_CONNECTORS_DECLARED", message: "Plugin connector surfaces are declared by the installed manifest.", details: { environmentDrivers: count(manifest.environmentDrivers), objectReferences: count(manifest.objectReferences) } }, `connectors-${plugin.id}`, timestamp));
  if (manifest.capabilities.some((capability) => capability.startsWith("mcp."))) result.push(derivedFact({ ...base, level: "info", category: "mcp", code: "SPS_PLUGIN_MCP_CAPABILITY_DECLARED", message: "Plugin declares an MCP capability.", details: {} }, `mcp-${plugin.id}`, timestamp));
  return result;
}

export function createPluginCanonicalDiagnostics(options: {
  db: Db;
  lifecycle: PluginLifecycleManager;
  workerManager: PluginWorkerManager;
  scheduler?: PluginJobScheduler;
}): PluginCanonicalDiagnostics {
  const registry = pluginRegistryService(options.db);
  const factsByPluginId = new Map<string, PluginDiagnosticFactV1[]>();
  const lifecycleListeners: Array<[keyof PluginLifecycleEvents, (payload: never) => void]> = [];
  const record = (input: FactInput): void => {
    const event = fact(input);
    const current = factsByPluginId.get(input.pluginId) ?? [];
    current.push(event);
    if (current.length > MAX_FACTS_PER_PLUGIN) current.splice(0, current.length - MAX_FACTS_PER_PLUGIN);
    factsByPluginId.set(input.pluginId, current);
  };
  const observe = <K extends keyof PluginLifecycleEvents>(event: K, category: PluginDiagnosticCategoryV1, code: string, level: PluginDiagnosticLevelV1, message: string) => {
    const listener = (payload: PluginLifecycleEvents[K]) => record({ origin: "core", level, category, code, pluginId: payload.pluginId, pluginKey: payload.pluginKey, message });
    options.lifecycle.on(event, listener);
    lifecycleListeners.push([event, listener as never]);
  };
  observe("plugin.status_changed", "event", "SPS_PLUGIN_LIFECYCLE_STATUS_CHANGED", "info", "Plugin lifecycle status changed.");
  observe("plugin.loaded", "event", "SPS_PLUGIN_RUNTIME_LOADED", "info", "Plugin runtime loaded.");
  observe("plugin.enabled", "event", "SPS_PLUGIN_RUNTIME_ENABLED", "info", "Plugin runtime enabled.");
  observe("plugin.disabled", "event", "SPS_PLUGIN_RUNTIME_DISABLED", "warn", "Plugin runtime disabled.");
  observe("plugin.unloaded", "event", "SPS_PLUGIN_RUNTIME_UNLOADED", "info", "Plugin runtime unloaded.");
  observe("plugin.error", "worker", "SPS_PLUGIN_RUNTIME_ERROR", "error", "Plugin runtime entered an error state.");
  observe("plugin.upgrade_pending", "capability", "SPS_PLUGIN_UPGRADE_PENDING", "warn", "Plugin upgrade requires review.");
  observe("plugin.worker_started", "worker", "SPS_PLUGIN_WORKER_STARTED", "info", "Plugin worker started.");
  observe("plugin.worker_stopped", "worker", "SPS_PLUGIN_WORKER_STOPPED", "info", "Plugin worker stopped.");

  return {
    record,
    async snapshot(pluginId, audience) {
      const plugin = await registry.getById(pluginId) as PluginRecord | null;
      if (!plugin) return null;
      const worker = options.workerManager.getWorker(pluginId)?.diagnostics() ?? null;
      const scheduler = options.scheduler?.diagnostics() ?? null;
      const facts = [...declaredFacts(plugin), ...(factsByPluginId.get(pluginId) ?? [])].slice(-MAX_FACTS_PER_PLUGIN);
      const visibleFacts = audience === "host" ? facts : facts.filter((item) => !HOST_ONLY_CATEGORIES.has(item.category));
      const hiddenCount = facts.length - visibleFacts.length;
      if (hiddenCount > 0 && audience === "member") visibleFacts.push(derivedFact({ pluginId: plugin.id, pluginKey: plugin.pluginKey, origin: "core", level: "info", category: "visibility", code: "SPS_PLUGIN_DIAGNOSTICS_REDACTED_FOR_MEMBER", message: "Some protected diagnostic facts are unavailable for this audience.", details: { hiddenFactCount: hiddenCount } }, `visibility-${plugin.id}-${facts.length}`, new Date().toISOString()));
      return {
        schemaVersion: PLUGIN_DIAGNOSTIC_SCHEMA_V1,
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        generatedAt: new Date().toISOString(),
        facts: visibleFacts.slice(-MAX_FACTS_PER_PLUGIN),
        runtime: {
          lifecycleStatus: plugin.status,
          declaredCapabilities: [...plugin.manifestJson.capabilities],
          worker: worker ? { status: worker.status, running: worker.status === "running", consecutiveCrashes: worker.consecutiveCrashes, totalCrashes: worker.totalCrashes, pendingRequests: worker.pendingRequests } : null,
          scheduler: scheduler ? { running: scheduler.running, activeJobCount: scheduler.activeJobCount } : null,
        },
      };
    },
    dispose() {
      for (const [event, listener] of lifecycleListeners) options.lifecycle.off(event, listener as never);
      lifecycleListeners.length = 0;
      factsByPluginId.clear();
    },
  };
}
