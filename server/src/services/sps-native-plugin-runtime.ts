import { createHash } from "node:crypto";
import type { Db } from "../compat/paperclip/db.js";
import { accessService } from "./access.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { createPluginUiActionAuthority } from "./plugin-ui-action-authority.js";
import type { PluginWorkerManager, WorkerInvocationAuthority } from "./plugin-worker-manager.js";
import { assertSpsPluginAvailable } from "./sps-plugin-availability.js";
import { spsWorkspaceSurfaceService } from "./sps-workspace-surfaces.js";
import { resolvePluginRecoveryState } from "./sps-plugin-recovery.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_REQUEST = 64 * 1024;
const MAX_RESULT = 256 * 1024;
const MAX_NODES = 8192;
const unavailable = () => new Error("Native Plugin access is unavailable.");

export type SpsNativePluginPrincipal = Readonly<{
  hostId: string;
  userId: string;
  deviceId: string;
  deviceRevision: number;
  certificateSha256: string;
  certificateNotAfter: number;
}>;
export type SpsNativePluginRequest = Readonly<{
  workspaceId: string;
  pluginId: string;
  surface: "shell" | "widget";
  surfaceId: string;
  operation: "data" | "action";
  key: string;
  params: Record<string, unknown>;
}>;

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (keys && (keys.length !== actual.length || actual.some(key => typeof key !== "string" || !keys.includes(key)))) throw unavailable();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    if (typeof key !== "string") throw unavailable();
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
    out[key] = descriptor.value;
  }
  return out;
}

/** Snapshot JSON without invoking getters/toJSON or retaining mutable caller objects. */
export function snapshotSpsNativePluginJson(value: unknown, maximum: number): unknown {
  let nodes = 0, characters = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > 24) throw unavailable();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw unavailable(); return item; }
    if (typeof item === "string") { characters += item.length; if (characters > maximum) throw unavailable(); return item; }
    if (!item || typeof item !== "object" || seen.has(item)) throw unavailable();
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > MAX_NODES) throw unavailable();
        const descriptors = Object.getOwnPropertyDescriptors(item);
        if (Reflect.ownKeys(descriptors).length !== item.length + 1) throw unavailable();
        const result: unknown[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const fields = record(item), result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(fields)) {
        characters += key.length;
        if (characters > maximum) throw unavailable();
        result[key] = visit(fields[key], depth + 1);
      }
      return result;
    } finally { seen.delete(item); }
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RESULT) throw unavailable();
  const snapshot = visit(value, 0);
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > maximum) throw unavailable();
  return JSON.parse(serialized) as unknown;
}

function principal(value: unknown): SpsNativePluginPrincipal {
  const input = record(value, ["hostId", "userId", "deviceId", "deviceRevision", "certificateSha256", "certificateNotAfter"]);
  if (typeof input.userId !== "string" || !input.userId || input.userId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.userId)
    || typeof input.hostId !== "string" || !UUID.test(input.hostId)
    || typeof input.deviceId !== "string" || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.deviceRevision) || (input.deviceRevision as number) < 1
    || typeof input.certificateSha256 !== "string" || !SHA.test(input.certificateSha256)
    || !Number.isSafeInteger(input.certificateNotAfter) || (input.certificateNotAfter as number) <= Date.now()) throw unavailable();
  return Object.freeze(input) as SpsNativePluginPrincipal;
}

function request(value: unknown): SpsNativePluginRequest {
  const input = record(value, ["workspaceId", "pluginId", "surface", "surfaceId", "operation", "key", "params"]);
  if (typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.pluginId !== "string" || !UUID.test(input.pluginId)
    || !["shell", "widget"].includes(String(input.surface)) || !["data", "action"].includes(String(input.operation))
    || typeof input.surfaceId !== "string" || !input.surfaceId || input.surfaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.surfaceId)
    || typeof input.key !== "string" || !input.key || input.key.length > 200 || /[\u0000-\u001f\u007f]/.test(input.key)) throw unavailable();
  record(input.params);
  return Object.freeze(snapshotSpsNativePluginJson(input, MAX_REQUEST)) as SpsNativePluginRequest;
}

/** Private app-owned adapter. Native identity is supplied by the verified reader,
 * never an actor in JSON. Plugin work runs outside the reader's DB transactions. */
export function createSpsNativePluginRuntime(db: Db, workerManager: PluginWorkerManager) {
  const registry = pluginRegistryService(db);
  const surfaces = spsWorkspaceSurfaceService(db);
  const actions = createPluginUiActionAuthority(accessService(db));
  let active = 0, disposed = false;
  const controllers = new Set<AbortController>();
  return Object.freeze({
    async invoke(input: SpsNativePluginRequest,
      authorizeNative: () => Promise<SpsNativePluginPrincipal>, signal?: AbortSignal): Promise<unknown> {
      if (disposed || active >= 2 || typeof authorizeNative !== "function"
        || (signal !== undefined && !(signal instanceof AbortSignal))) throw unavailable();
      const selected = request(input);
      active++;
      const controller = new AbortController(); controllers.add(controller);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const check = () => { if (disposed || controller.signal.aborted || resolvePluginRecoveryState().enabled) throw unavailable(); };
      try {
        check();
        const expected = principal(await authorizeNative());
        let pluginSnapshot: string | undefined;
        let permissionSnapshot: string | undefined;
        const requested = actions.requestedPermissions(selected.params);
        const actor = { type: "user" as const, userId: expected.userId, agentId: null,
          runId: null, companyId: selected.workspaceId, hostAuthority: false };
        const authorize = async () => {
          check();
          const current = principal(await authorizeNative());
          if (Object.keys(expected).some(key => current[key as keyof SpsNativePluginPrincipal] !== expected[key as keyof SpsNativePluginPrincipal])) throw unavailable();
          await assertSpsPluginAvailable(db, { companyId: selected.workspaceId, pluginId: selected.pluginId },
            selected.surface === "shell" ? "ui.workspaceShell.provide" : "ui.dashboard.contribute");
          const plugin = await registry.getById(selected.pluginId);
          if (!plugin || plugin.status !== "ready") throw unavailable();
          const snapshot = createHash("sha256").update(JSON.stringify({ version: plugin.version,
            updatedAt: plugin.updatedAt, manifest: plugin.manifestJson })).digest("hex");
          if (pluginSnapshot !== undefined && snapshot !== pluginSnapshot) throw unavailable();
          pluginSnapshot = snapshot;
          if (selected.surface === "shell") {
            const shell = await surfaces.getShell(selected.workspaceId);
            if (shell.mode !== "plugin" || shell.providerPluginId !== selected.pluginId || shell.shell?.id !== selected.surfaceId) throw unavailable();
          } else {
            const widgets = await surfaces.listDashboard(selected.workspaceId, expected.userId);
            if (!widgets.some(widget => widget.pluginId === selected.pluginId && widget.widget.id === selected.surfaceId)) throw unavailable();
          }
          if (permissionSnapshot !== undefined
            && JSON.stringify((await actions.actorContext(actor, requested)).permissions ?? []) !== permissionSnapshot) throw unavailable();
          check();
        };
        await authorize();
        const authority: WorkerInvocationAuthority = { assertCurrent: authorize, signal: controller.signal,
          readNativeConnectivity: async () => {
            await authorize();
            return Object.freeze({ state: "verified" as const, transport: "native_tls" as const,
              hostId: expected.hostId, workspaceId: selected.workspaceId, authorization: "authorized" as const,
              evidence: "authenticated_request" as const, observedAt: new Date().toISOString() });
          },
        };
        const params = actions.actionParams(selected.params, selected.workspaceId);
        let result: unknown;
        if (selected.operation === "data") {
          result = await workerManager.call(selected.pluginId, "getData", {
            key: selected.key, companyId: selected.workspaceId, params, renderEnvironment: null,
          }, 10_000, authority);
        } else {
          const actorContext = await actions.actorContext(actor, requested);
          permissionSnapshot = JSON.stringify(actorContext.permissions ?? []);
          await authorize();
          result = await workerManager.call(selected.pluginId, "performAction", {
            key: selected.key, companyId: selected.workspaceId, params, actorContext, renderEnvironment: null,
          }, 10_000, authority);
        }
        await authorize();
        return snapshotSpsNativePluginJson(result === undefined ? null : result, MAX_RESULT - 32);
      } catch { throw unavailable(); }
      finally {
        controller.abort(); signal?.removeEventListener("abort", onAbort);
        controllers.delete(controller); active--;
      }
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); },
  });
}
