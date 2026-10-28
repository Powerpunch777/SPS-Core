import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HostServices, HostToWorkerMethods } from "../compat/paperclip/plugin-sdk.js";
import type { Db } from "../compat/paperclip/db.js";
import type { PluginRecord } from "../compat/paperclip/shared.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginStreamBus } from "./plugin-stream-bus.js";
import { publishPluginStreamNotification } from "./plugin-stream-notifications.js";
import { createSpsWorkspacePluginEventBus } from "./sps-workspace-plugin-event-bus.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerHandle, PluginWorkerManager, WorkerInvocationAuthority } from "../compat/paperclip/control-plane.js";
import { readSpsPluginAuthorityRevision, sameSpsPluginAuthorityRevision,
  type SpsPluginAuthorityRevision } from "./sps-plugin-authority-revision.js";
import { createSpsWorkspacePluginConfigService, validateSpsWorkspacePluginConfig } from "./sps-workspace-plugin-config.js";
import { createSpsWorkspacePluginHostHandlers } from "./sps-workspace-plugin-host.js";
import { assertSpsWorkspaceExecutionActive, registerSpsWorkspaceExecutionStopHandler,
  withSpsWorkspaceExecutionAdmission } from "./sps-workspace-execution-control.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const unavailable = () => new Error("Workspace Plugin runtime is unavailable.");
type Services = HostServices & { dispose(): void };
type Owner = Readonly<{ workspaceId: string; pluginId: string }>;
type Runtime = Owner & {
  epoch: string;
  policy: SpsPluginAuthorityRevision;
  configRevision: string | null;
  handle?: PluginWorkerHandle;
  streamGeneration?: string;
  disposeServices(): void;
};
const factoryOwners = new WeakMap<PluginWorkerManager, object>();

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** Resolve only the declared package entry; no absolute/cwd/Host-worker fallback. */
export async function resolveSpsWorkspacePluginEntrypoint(plugin: PluginRecord, localPluginDir: string): Promise<string> {
  const entry = plugin.manifestJson.entrypoints.workspaceWorker;
  if (typeof entry !== "string" || !entry || entry.length > 512 || path.isAbsolute(entry)
    || /[\\\x00-\x1f\x7f]/.test(entry) || /^[a-z][a-z0-9+.-]*:/i.test(entry)
    || entry.split("/").includes("..")) throw unavailable();
  const packagePath = (plugin as PluginRecord & { packagePath?: string | null }).packagePath;
  let roots: string[];
  if (packagePath) roots = [packagePath];
  else {
    if (!/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(plugin.packageName)) throw unavailable();
    roots = [path.join(localPluginDir, "node_modules", ...plugin.packageName.split("/")),
      path.join(localPluginDir, ...plugin.packageName.split("/"))];
  }
  for (const candidateRoot of roots) {
    try {
      const root = await realpath(candidateRoot);
      const lexical = path.resolve(root, entry);
      if (!inside(root, lexical)) throw unavailable();
      const resolved = await realpath(lexical);
      if (!inside(root, resolved) || !(await stat(resolved)).isFile()) throw unavailable();
      return resolved;
    } catch (error) {
      if (packagePath || (error as NodeJS.ErrnoException)?.code !== "ENOENT") throw unavailable();
    }
  }
  throw unavailable();
}

/** Workspace-owned UI/action workers. This is process ownership, not an OS sandbox. */
export function createSpsWorkspacePluginWorkers(db: Db, manager: PluginWorkerManager, options: {
  localPluginDir: string;
  instanceInfo?: { instanceId: string; hostVersion: string };
  eventBus?: PluginEventBus;
  streamBus?: PluginStreamBus;
  buildServices?: (plugin: PluginRecord, workspaceId: string) => Services | Promise<Services>;
  resolveEntrypoint?: typeof resolveSpsWorkspacePluginEntrypoint;
}) {
  // A second private factory must not silently adopt another factory's scoped
  // handles or overwrite its stop callback. Reuse one factory in a composition.
  if (factoryOwners.has(manager)) throw unavailable();
  const factoryOwner = {};
  factoryOwners.set(manager, factoryOwner);
  const registry = pluginRegistryService(db);
  const configurations = createSpsWorkspacePluginConfigService(db);
  const owners = new Map<string, Owner>();
  const runtimes = new Map<string, Runtime>();
  const locks = new Map<string, Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  function keyFor(workspaceId: string, pluginId: string) {
    if (!UUID.test(workspaceId) || !UUID.test(pluginId)) throw unavailable();
    const key = JSON.stringify([workspaceId, pluginId]);
    if (!owners.has(key)) owners.set(key, Object.freeze({ workspaceId, pluginId }));
    return key;
  }

  async function locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(key, current);
    try { await previous; return await action(); }
    finally {
      release();
      if (locks.get(key) === current) {
        locks.delete(key);
        if (!runtimes.has(key)) owners.delete(key);
      }
    }
  }

  async function assertCurrent(runtime: Runtime) {
    if (closed || runtimes.get(JSON.stringify([runtime.workspaceId, runtime.pluginId])) !== runtime) throw unavailable();
    await assertSpsWorkspaceExecutionActive(db, runtime.workspaceId, runtime.epoch);
    const current = await readSpsPluginAuthorityRevision(db, runtime.workspaceId);
    if (!sameSpsPluginAuthorityRevision(runtime.policy, current)) throw unavailable();
  }

  async function retire(key: string, runtime: Runtime) {
    // A stop failure retains the manager's exact child and these Host services.
    // Never replace an unconfirmed process or dispose services under live work.
    await manager.stopWorkspaceWorkers(runtime.workspaceId, runtime.pluginId);
    if (runtime.streamGeneration) options.streamBus?.closeOwner(runtime.pluginId, runtime.workspaceId, runtime.streamGeneration);
    runtime.disposeServices();
    if (runtimes.get(key) === runtime) runtimes.delete(key);
  }

  async function ensure(workspaceId: string, pluginId: string, epoch: string): Promise<Runtime> {
    const key = keyFor(workspaceId, pluginId);
    return locked(key, async () => {
      if (closed) throw unavailable();
      await assertSpsWorkspaceExecutionActive(db, workspaceId, epoch);
      const policy = await readSpsPluginAuthorityRevision(db, workspaceId);
      const existing = runtimes.get(key);
      if (existing && existing.epoch === epoch && sameSpsPluginAuthorityRevision(existing.policy, policy)
        && existing.handle?.status === "running"
        && manager.getWorkspaceWorker(workspaceId, pluginId) === existing.handle) return existing;
      if (existing) await retire(key, existing);
      // An owned manager entry without its factory record is not a usable legacy
      // substitute. Confirm closure before constructing fresh tenant services.
      if (manager.getWorkspaceWorker(workspaceId, pluginId)) await manager.stopWorkspaceWorkers(workspaceId, pluginId);
      const plugin = await registry.getById(pluginId) as PluginRecord | null;
      if (!plugin || plugin.status !== "ready" || !plugin.manifestJson.entrypoints.workspaceWorker) throw unavailable();
      const configuration = await configurations.get(workspaceId, pluginId);
      const config = validateSpsWorkspacePluginConfig(plugin.manifestJson, configuration.configJson);
      const entrypointPath = await (options.resolveEntrypoint ?? resolveSpsWorkspacePluginEntrypoint)(plugin, options.localPluginDir);
      if (!sameSpsPluginAuthorityRevision(policy, await readSpsPluginAuthorityRevision(db, workspaceId))) throw unavailable();
      await assertSpsWorkspaceExecutionActive(db, workspaceId, epoch);
      // Core's full app already has this adapter loaded. Keep minimal Native
      // compositions independent of unrelated Host/Agent lifecycle imports.
      const services = options.buildServices
        ? await options.buildServices(plugin, workspaceId)
        : (await import("./plugin-host-services.js")).buildHostServices(db, pluginId,
          plugin.pluginKey, createSpsWorkspacePluginEventBus(options.eventBus, workspaceId, plugin.pluginKey), undefined,
          { pluginWorkerManager: manager, manifest: plugin.manifestJson, workspaceId });
      // Building adapters may await module loading. Do not start a process with
      // configuration invalidated during that interval.
      try {
        if (closed || !sameSpsPluginAuthorityRevision(policy, await readSpsPluginAuthorityRevision(db, workspaceId))) throw unavailable();
        await assertSpsWorkspaceExecutionActive(db, workspaceId, epoch);
      } catch {
        services.dispose();
        throw unavailable();
      }
      const runtime: Runtime = { workspaceId, pluginId, epoch, policy,
        configRevision: configuration.revision, disposeServices: () => services.dispose() };
      runtimes.set(key, runtime);
      const readConfig = async () => {
        await assertCurrent(runtime);
        return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
      };
      const instanceInfo = options.instanceInfo ?? { instanceId: "sps-native-workspace", hostVersion: "0.0.0" };
      try {
        const starting = manager.startWorkspaceWorker(workspaceId, pluginId, {
          entrypointPath, manifest: plugin.manifestJson, config: JSON.parse(JSON.stringify(config)), instanceInfo,
          apiVersion: plugin.manifestJson.apiVersion, databaseNamespace: null, autoRestart: false,
          hostHandlers: createSpsWorkspacePluginHostHandlers({ workspaceId, pluginId,
            manifest: plugin.manifestJson, services, readConfig }),
          onStreamNotification: options.streamBus ? async (method, params, generation, canPublish) => {
            if (params.companyId !== workspaceId || runtimes.get(key) !== runtime
              || (runtime.streamGeneration !== undefined && runtime.streamGeneration !== generation)) return;
            runtime.streamGeneration ??= generation;
            // A terminal close only removes this exact generation's channel. It
            // must remain possible after stop/config invalidates call authority.
            if (method !== "streams.close") await assertCurrent(runtime);
            if (runtimes.get(key) !== runtime || runtime.streamGeneration !== generation
              || (method !== "streams.close" && !canPublish?.())) return;
            publishPluginStreamNotification(options.streamBus!, pluginId, method, params, generation);
          } : undefined,
          // Workspace workers use brokered Host APIs. Do not forward the Host
          // worker's Agent/CLI environment or instance-wide configuration.
          env: { SPS_PLUGIN_WORKSPACE_ID: workspaceId },
        });
        runtime.handle = manager.getWorkspaceWorker(workspaceId, pluginId);
        runtime.handle = await starting;
        runtime.handle.on("exit", () => {
          void locked(key, async () => {
            if (runtimes.get(key) === runtime) await retire(key, runtime);
          }).catch(() => { /* Retain an unconfirmed owner; later stop must still join it. */ });
        });
        if (runtime.handle.status !== "running") throw unavailable();
        await assertCurrent(runtime);
        return runtime;
      } catch {
        await retire(key, runtime);
        throw unavailable();
      }
    });
  }

  const unregisterStop = registerSpsWorkspaceExecutionStopHandler(db, `sps-workspace-plugin-workers:${randomUUID()}`, async (workspaceId, _reason, stoppedEpoch) => {
    const selected = [...owners].filter(([, owner]) => owner.workspaceId === workspaceId);
    const results = await Promise.allSettled(selected.map(([key]) => locked(key, async () => {
      const runtime = runtimes.get(key);
      // A delayed stop fanout cannot terminate a worker admitted after resume.
      if (runtime && BigInt(runtime.epoch) < BigInt(stoppedEpoch)) await retire(key, runtime);
    })));
    if (results.some(result => result.status === "rejected")) throw unavailable();
  }, workspaceId => [...owners].filter(([key, owner]) => owner.workspaceId === workspaceId
    && (runtimes.has(key) || locks.has(key))).length);

  return Object.freeze({
    async call<M extends "getData" | "performAction">(workspaceId: string, pluginId: string, method: M,
      params: HostToWorkerMethods[M][0], timeoutMs: number, authority: WorkerInvocationAuthority): Promise<HostToWorkerMethods[M][1]> {
      if (closed || authority.signal?.aborted || authority.boundWorkspaceId !== workspaceId) throw unavailable();
      await authority.assertCurrent();
      const epoch = await withSpsWorkspaceExecutionAdmission(db, workspaceId, async (_tx, admittedEpoch) => admittedEpoch);
      if (authority.signal?.aborted) throw unavailable();
      const runtime = await ensure(workspaceId, pluginId, epoch);
      const guarded = Object.freeze({ ...authority, boundWorkspaceId: workspaceId,
        assertCurrent: async () => { await authority.assertCurrent(); await assertCurrent(runtime); } });
      return manager.callWorkspaceWorker(workspaceId, pluginId, method, params, timeoutMs, guarded);
    },
    async invalidate(workspaceId: string, pluginId: string, previousRevision: string | null) {
      const key = keyFor(workspaceId, pluginId);
      await locked(key, async () => {
        const runtime = runtimes.get(key);
        if (runtime && runtime.configRevision === previousRevision) await retire(key, runtime);
      });
    },
    closeAdmission() { closed = true; },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      const selected = new Set([...runtimes.keys(), ...locks.keys()]);
      const attempt = Promise.allSettled([...selected].map(key => locked(key, async () => {
        const runtime = runtimes.get(key);
        if (runtime) await retire(key, runtime);
      }))).then(results => {
        if (results.some(result => result.status === "rejected")) throw unavailable();
        unregisterStop();
        if (factoryOwners.get(manager) === factoryOwner) factoryOwners.delete(manager);
      });
      shutdownPromise = attempt;
      // Keep callers of this attempt joined, but let a later shutdown call retry
      // exact retained handles after a stop failure. Admission remains closed.
      void attempt.catch(() => {
        if (shutdownPromise === attempt) shutdownPromise = undefined;
      });
      return attempt;
    },
  });
}

export type SpsWorkspacePluginWorkers = ReturnType<typeof createSpsWorkspacePluginWorkers>;
