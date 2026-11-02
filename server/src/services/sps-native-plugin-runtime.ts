import { createHash } from "node:crypto";
import type { Db } from "../compat/paperclip/db.js";
import type {
  PluginDashboardWidgetDeclaration,
  PluginRecord,
} from "../compat/paperclip/shared.js";
type PluginUiSlotDeclaration = NonNullable<NonNullable<PluginRecord["manifestJson"]["ui"]>["slots"]>[number];
import { accessService } from "./access.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { createPluginUiActionAuthority } from "./plugin-ui-action-authority.js";
import type { PluginWorkerManager, WorkerInvocationAuthority } from "./plugin-worker-manager.js";
import { assertSpsPluginAvailable } from "./sps-plugin-availability.js";
import { readSpsPluginAuthorityRevision, sameSpsPluginAuthorityRevision,
  type SpsPluginAuthorityRevision } from "./sps-plugin-authority-revision.js";
import { createSpsWorkspacePluginWorkers, type SpsWorkspacePluginWorkers } from "./sps-workspace-plugin-workers.js";
import { spsWorkspaceSurfaceService } from "./sps-workspace-surfaces.js";
import { resolvePluginRecoveryState } from "./sps-plugin-recovery.js";
import { createSpsNativePluginUiAssetService, type SpsNativePluginUiAsset } from "./sps-native-plugin-ui-assets.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_REQUEST = 64 * 1024;
const MAX_RESULT = 256 * 1024;
const MAX_ASSET_RESULT = 6 * 1024 * 1024;
const MAX_NODES = 8192;
const unavailable = () => new Error("Native Plugin access is unavailable.");

export type SpsNativePluginOperation = "describe" | "asset" | "data" | "action";
export type SpsNativePluginRuntimeOptions = {
  localPluginDir: string;
  instanceInfo?: { instanceId: string; hostVersion: string };
  workspaceWorkers?: SpsWorkspacePluginWorkers;
  workspaceBuildServices?: Parameters<typeof createSpsWorkspacePluginWorkers>[2]["buildServices"];
  workspaceEventBus?: Parameters<typeof createSpsWorkspacePluginWorkers>[2]["eventBus"];
};

export class SpsNativePluginUnsupportedError extends Error {
  readonly code = "native_plugin_ui_unsupported";
  readonly status = 501;
  constructor() {
    super("This Native Plugin surface has no declared renderable page.");
    this.name = "SpsNativePluginUnsupportedError";
  }
}

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
  revision?: string | null;
  operation: SpsNativePluginOperation;
  key: string;
  params: Record<string, unknown>;
}>;
export type SpsNativePluginSurfaceDescriptor = Readonly<{
  v: 1;
  kind: "sps.native.plugin.surface";
  workspaceId: string;
  pluginId: string;
  pluginKey: string;
  displayName: string;
  revision: string;
  surface: "shell" | "widget";
  surfaceId: string;
  entryFile: "index.js";
  exportName: string;
  widget: PluginDashboardWidgetDeclaration | null;
  slot: PluginUiSlotDeclaration | null;
  cssFiles: readonly string[];
}>;
export type { SpsNativePluginUiAsset };

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
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ASSET_RESULT) throw unavailable();
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

function relativeAssetPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.startsWith("/")
    || value.startsWith("\\") || value.includes("\\") || value.includes("%") || /[\u0000-\u001f\u007f:?#]/.test(value)) throw unavailable();
  const segments = value.split("/");
  if (segments.length > 8 || segments.some(segment => !segment || segment === "." || segment === ".."
    || !/^[A-Za-z0-9._-]+$/.test(segment))) throw unavailable();
  return segments.join("/");
}

function request(value: unknown): SpsNativePluginRequest {
  const input = record(value);
  const legacyKeys = ["workspaceId", "pluginId", "surface", "surfaceId", "operation", "key", "params"] as const;
  const revisedKeys = [...legacyKeys.slice(0, 4), "revision", ...legacyKeys.slice(4)];
  const actualKeys = Reflect.ownKeys(input);
  const hasRevision = Object.hasOwn(input, "revision");
  const expectedKeys = hasRevision ? revisedKeys : legacyKeys;
  if (actualKeys.length !== expectedKeys.length || actualKeys.some(key => typeof key !== "string" || !expectedKeys.includes(key as never))) throw unavailable();
  if (typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.pluginId !== "string" || !UUID.test(input.pluginId)
    || !["shell", "widget"].includes(String(input.surface))
    || !["describe", "asset", "data", "action"].includes(String(input.operation))
    || typeof input.surfaceId !== "string" || !input.surfaceId || input.surfaceId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.surfaceId)
    || typeof input.key !== "string" || !input.key || input.key.length > 200 || /[\u0000-\u001f\u007f]/.test(input.key)) throw unavailable();
  const operation = input.operation as SpsNativePluginOperation;
  if (operation === "describe") {
    if (!hasRevision || input.revision !== null || input.key !== "surface" || Reflect.ownKeys(record(input.params)).length !== 0) throw unavailable();
  } else {
    if (operation === "asset") {
      if (!hasRevision || typeof input.revision !== "string" || !SHA.test(input.revision)
        || Reflect.ownKeys(record(input.params)).length !== 0) throw unavailable();
      input.key = relativeAssetPath(input.key);
    } else if (hasRevision && (typeof input.revision !== "string" || !SHA.test(input.revision))) throw unavailable();
    record(input.params);
  }
  return Object.freeze(snapshotSpsNativePluginJson(input, MAX_REQUEST)) as SpsNativePluginRequest;
}

function surfaceDescriptor(input: {
  workspaceId: string; plugin: PluginRecord; revision: string; surface: "shell" | "widget"; surfaceId: string;
  widget: PluginDashboardWidgetDeclaration | null; slot: PluginUiSlotDeclaration | null; cssFiles: readonly string[];
}): SpsNativePluginSurfaceDescriptor {
  const exportName = input.widget?.exportName ?? input.slot?.exportName;
  if (typeof exportName !== "string" || !exportName) throw unavailable();
  return Object.freeze({
    v: 1,
    kind: "sps.native.plugin.surface",
    workspaceId: input.workspaceId,
    pluginId: input.plugin.id,
    pluginKey: input.plugin.pluginKey,
    displayName: input.plugin.manifestJson.displayName,
    revision: input.revision,
    surface: input.surface,
    surfaceId: input.surfaceId,
    entryFile: "index.js",
    exportName,
    widget: input.widget ? snapshotSpsNativePluginJson(input.widget, 64 * 1024) as PluginDashboardWidgetDeclaration : null,
    slot: input.slot ? snapshotSpsNativePluginJson(input.slot, 64 * 1024) as PluginUiSlotDeclaration : null,
    cssFiles: input.cssFiles,
  });
}

/** Private app-owned adapter. Native identity is supplied by the verified reader,
 * never an actor in JSON. Plugin work runs outside the reader's DB transactions. */
export function createSpsNativePluginRuntime(
  db: Db,
  workerManager: PluginWorkerManager,
  options?: SpsNativePluginRuntimeOptions,
) {
  const registry = pluginRegistryService(db);
  const surfaces = spsWorkspaceSurfaceService(db);
  const actions = createPluginUiActionAuthority(accessService(db));
  const uiAssets = options ? createSpsNativePluginUiAssetService(options) : null;
  let workspaceWorkers = options?.workspaceWorkers;
  function scopedWorkers() {
    if (!options) throw new SpsNativePluginUnsupportedError();
    return workspaceWorkers ??= createSpsWorkspacePluginWorkers(db, workerManager, {
      localPluginDir: options.localPluginDir, instanceInfo: options.instanceInfo,
      buildServices: options.workspaceBuildServices,
      eventBus: options.workspaceEventBus,
    });
  }
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
        let authorityRevision: SpsPluginAuthorityRevision | undefined;
        const requested = selected.operation === "action" ? actions.requestedPermissions(selected.params) : [];
        const actor = { type: "user" as const, userId: expected.userId, agentId: null,
          runId: null, companyId: selected.workspaceId, hostAuthority: false };
        const authorize = async () => {
          check();
          const current = principal(await authorizeNative());
          if (Object.keys(expected).some(key => current[key as keyof SpsNativePluginPrincipal] !== expected[key as keyof SpsNativePluginPrincipal])) throw unavailable();
          const before = await readSpsPluginAuthorityRevision(db, selected.workspaceId);
          if (authorityRevision && !sameSpsPluginAuthorityRevision(authorityRevision, before)) throw unavailable();
          await assertSpsPluginAvailable(db, { companyId: selected.workspaceId, pluginId: selected.pluginId },
            selected.surface === "shell" ? "ui.workspaceShell.provide" : "ui.dashboard.contribute");
          const plugin = await registry.getById(selected.pluginId);
          if (!plugin || plugin.status !== "ready") throw unavailable();
          const snapshot = createHash("sha256").update(JSON.stringify({ version: plugin.version,
            updatedAt: plugin.updatedAt, manifest: plugin.manifestJson })).digest("hex");
          if (pluginSnapshot !== undefined && snapshot !== pluginSnapshot) throw unavailable();
          if (selected.operation !== "describe" && selected.revision !== undefined && selected.revision !== snapshot) throw unavailable();
          pluginSnapshot = snapshot;
          let widget: PluginDashboardWidgetDeclaration | null = null;
          if (selected.surface === "shell") {
            const shell = await surfaces.getShell(selected.workspaceId);
            if (shell.mode !== "plugin" || shell.providerPluginId !== selected.pluginId || shell.shell?.id !== selected.surfaceId) throw unavailable();
          } else {
            const widgets = await surfaces.listDashboard(selected.workspaceId, expected.userId);
            const selectedWidget = widgets.find(item => item.pluginId === selected.pluginId && item.widget.id === selected.surfaceId);
            if (!selectedWidget) throw unavailable();
            widget = selectedWidget.widget;
          }
          if (selected.operation === "action" && permissionSnapshot !== undefined
            && JSON.stringify((await actions.actorContext(actor, requested)).permissions ?? []) !== permissionSnapshot) throw unavailable();
          const after = await readSpsPluginAuthorityRevision(db, selected.workspaceId);
          if (!sameSpsPluginAuthorityRevision(before, after)) throw unavailable();
          authorityRevision ??= after;
          check();
          return { plugin, revision: snapshot, widget };
        };
        const initial = await authorize();
        if (selected.operation === "describe") {
          if (!uiAssets) throw unavailable();
          const manifest = initial.plugin.manifestJson;
          let widget: PluginDashboardWidgetDeclaration | null = null;
          let slot: PluginUiSlotDeclaration | null = null;
          if (selected.surface === "widget") {
            widget = initial.widget;
          } else {
            const shell = manifest.ui?.workspaceShell;
            const pages = (manifest.ui?.slots ?? []).filter(item => item.type === "page");
            const defaultRoute = shell?.defaultRoute;
            const routePath = typeof defaultRoute === "string" && defaultRoute.startsWith("/")
              ? defaultRoute.slice(1).split("/").length === 1 ? defaultRoute.slice(1) : null
              : null;
            slot = (routePath ? pages.find(item => item.routePath === routePath) : undefined) ?? pages[0] ?? null;
            if (!slot) throw new SpsNativePluginUnsupportedError();
          }
          const cssFiles = await uiAssets.listCss(initial.plugin);
          const descriptor = surfaceDescriptor({ workspaceId: selected.workspaceId, plugin: initial.plugin,
            revision: initial.revision, surface: selected.surface, surfaceId: selected.surfaceId, widget, slot, cssFiles });
          await authorize();
          return snapshotSpsNativePluginJson(descriptor, MAX_RESULT - 32);
        }
        if (selected.operation === "asset") {
          if (!uiAssets) throw unavailable();
          const asset: SpsNativePluginUiAsset = await uiAssets.read(initial.plugin, selected.key);
          await authorize();
          return snapshotSpsNativePluginJson(asset, MAX_ASSET_RESULT - 32);
        }
        const authority: WorkerInvocationAuthority = { boundWorkspaceId: selected.workspaceId,
          assertCurrent: async () => { await authorize(); }, signal: controller.signal,
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
          const payload = {
            key: selected.key, companyId: selected.workspaceId, params, renderEnvironment: null,
          };
          result = initial.plugin.manifestJson.entrypoints.workspaceWorker
            ? await scopedWorkers().call(selected.workspaceId, selected.pluginId, "getData", payload, 10_000, authority)
            : await workerManager.call(selected.pluginId, "getData", payload, 10_000, authority);
        } else {
          const actorContext = await actions.actorContext(actor, requested);
          permissionSnapshot = JSON.stringify(actorContext.permissions ?? []);
          await authorize();
          const payload = {
            key: selected.key, companyId: selected.workspaceId, params, actorContext, renderEnvironment: null,
          };
          result = initial.plugin.manifestJson.entrypoints.workspaceWorker
            ? await scopedWorkers().call(selected.workspaceId, selected.pluginId, "performAction", payload, 10_000, authority)
            : await workerManager.call(selected.pluginId, "performAction", payload, 10_000, authority);
        }
        await authorize();
        return snapshotSpsNativePluginJson(result === undefined ? null : result, MAX_RESULT - 32);
      } catch (error) {
        if (error instanceof SpsNativePluginUnsupportedError) throw error;
        throw unavailable();
      }
      finally {
        controller.abort(); signal?.removeEventListener("abort", onAbort);
        controllers.delete(controller); active--;
      }
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      workspaceWorkers?.closeAdmission();
    },
    async invalidateWorkspaceConfig(workspaceId: string, pluginId: string, previousRevision: string | null) {
      await workspaceWorkers?.invalidate(workspaceId, pluginId, previousRevision);
    },
    async shutdownWorkspaceWorkers() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      await workspaceWorkers?.shutdown();
    },
  });
}
