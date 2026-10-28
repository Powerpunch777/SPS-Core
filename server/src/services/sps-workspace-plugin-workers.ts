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
import { assertSpsWorkspaceExecutionActive, getSpsWorkspaceExecutionControl, registerSpsWorkspaceExecutionStopHandler,
  withSpsWorkspaceExecutionAdmission } from "./sps-workspace-execution-control.js";
import { readSpsWorkspacePresence } from "./sps-workspace-presence.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export class SpsWorkspacePluginRuntimeUnavailableError extends Error {
  readonly code = "sps_workspace_plugin_runtime_unavailable";
  constructor() { super("Workspace Plugin runtime is unavailable."); this.name = "SpsWorkspacePluginRuntimeUnavailableError"; }
}
const unavailable = () => new SpsWorkspacePluginRuntimeUnavailableError();
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
  policyReconcileIntervalMs?: number;
  onPolicyReconcileError?: () => void;
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
  const mutatingPlugins = new Set<string>();
  const mutatingWorkspaces = new Set<string>();
  const mutationPromises = new Set<Promise<unknown>>();
  let closed = false;
  let catalogMutationActive = false;
  let shutdownPromise: Promise<void> | undefined;
  let policySweepPromise: Promise<void> | undefined;
  let policySweepRequestedGeneration = 0;
  let policySweepCompletedGeneration = 0;
  const policySweepWaiters: Array<{
    generation: number;
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  let policySweepTimer: NodeJS.Timeout | undefined;

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
    if (!await readSpsWorkspacePresence(db, runtime.workspaceId)) throw unavailable();
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

  async function policyIsStale(runtime: Runtime): Promise<boolean> {
    // Complete every read before stopping anything. A transient DB failure is
    // not evidence that the captured owner is stale and must retain its child.
    if (!await readSpsWorkspacePresence(db, runtime.workspaceId)) return true;
    const [execution, policy, plugin] = await Promise.all([
      getSpsWorkspaceExecutionControl(db, runtime.workspaceId),
      readSpsPluginAuthorityRevision(db, runtime.workspaceId),
      registry.getById(runtime.pluginId) as Promise<PluginRecord | null>,
    ]);
    return execution.state === "stopped"
      || execution.epoch !== runtime.epoch
      || !sameSpsPluginAuthorityRevision(runtime.policy, policy)
      || !plugin
      || plugin.status !== "ready"
      || !plugin.manifestJson.entrypoints.workspaceWorker;
  }

  async function reconcileOwnerKeys(selectedKeys: string[]): Promise<void> {
    const results = await Promise.allSettled(selectedKeys.map(key => locked(key, async () => {
      const runtime = runtimes.get(key);
      if (!runtime) return;
      if (await policyIsStale(runtime)) await retire(key, runtime);
    })));
    if (results.some(result => result.status === "rejected")) throw unavailable();
  }

  function settlePolicySweepWaiters(generation: number, failed: boolean, error?: unknown): void {
    for (let index = policySweepWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = policySweepWaiters[index]!;
      if (waiter.generation > generation) continue;
      policySweepWaiters.splice(index, 1);
      if (failed) waiter.reject(error);
      else waiter.resolve();
    }
  }

  function startCatalogPolicySweepLoop(): void {
    if (policySweepPromise) return;
    const attempt = (async () => {
      while (policySweepCompletedGeneration < policySweepRequestedGeneration) {
        // Requests received during this pass require a fresh read after it.
        // Coalesce them into the next pass, but never let an old snapshot
        // satisfy a reconcile requested after a catalog mutation committed.
        const generation = policySweepRequestedGeneration;
        let failed = false;
        let failure: unknown;
        try { await reconcileOwnerKeys([...owners.keys()]); }
        catch (error) { failed = true; failure = error; }
        policySweepCompletedGeneration = generation;
        settlePolicySweepWaiters(generation, failed, failure);
      }
    })();
    policySweepPromise = attempt;
    const finish = () => {
      if (policySweepPromise === attempt) policySweepPromise = undefined;
      // A request can arrive after the loop's final condition but before this
      // completion callback clears the single-flight promise.
      if (policySweepCompletedGeneration < policySweepRequestedGeneration) {
        startCatalogPolicySweepLoop();
      }
    };
    void attempt.then(finish, error => {
      // Do not leave callers waiting if an unexpected error escapes the loop.
      const failedGeneration = policySweepRequestedGeneration;
      policySweepCompletedGeneration = failedGeneration;
      settlePolicySweepWaiters(failedGeneration, true, error);
      finish();
    });
  }

  async function joinCatalogPolicySweeps(): Promise<void> {
    while (policySweepPromise || policySweepCompletedGeneration < policySweepRequestedGeneration) {
      if (!policySweepPromise) startCatalogPolicySweepLoop();
      const active = policySweepPromise;
      if (active) await active.catch(() => undefined);
    }
  }

  function runCatalogPolicySweep(): Promise<void> {
    if (closed) return Promise.reject(unavailable());
    const generation = ++policySweepRequestedGeneration;
    const result = new Promise<void>((resolve, reject) => {
      policySweepWaiters.push({ generation, resolve, reject });
    });
    startCatalogPolicySweepLoop();
    return result;
  }

  const reconcileInterval = options.policyReconcileIntervalMs ?? 5_000;
  if (Number.isFinite(reconcileInterval) && reconcileInterval > 0) {
    policySweepTimer = setInterval(() => {
      if (closed || owners.size === 0 || policySweepPromise) return;
      void runCatalogPolicySweep().catch(() => {
        try { options.onPolicyReconcileError?.(); } catch { /* Keep the background sweep isolated. */ }
      });
    }, reconcileInterval);
    policySweepTimer.unref?.();
  }

  async function drainOwnerKeys(selectedKeys: string[]): Promise<void> {
    const results = await Promise.allSettled(selectedKeys.map(key => locked(key, async () => {
      const owner = owners.get(key);
      if (!owner) return;
      const runtime = runtimes.get(key);
      if (runtime) {
        await retire(key, runtime);
        return;
      }
      // A manager-owned child without a factory record is still selected by
      // this factory's owner key; confirm its process and stdio close as well.
      if (manager.getWorkspaceWorker(owner.workspaceId, owner.pluginId)) {
        await manager.stopWorkspaceWorkers(owner.workspaceId, owner.pluginId);
      }
    })));
    if (results.some(result => result.status === "rejected")) throw unavailable();
  }

  function trackMutation<T>(action: () => Promise<T>): Promise<T> {
    const attempt = Promise.resolve().then(action);
    mutationPromises.add(attempt);
    void attempt.then(() => mutationPromises.delete(attempt), () => mutationPromises.delete(attempt));
    return attempt;
  }

  async function ensure(workspaceId: string, pluginId: string, epoch: string): Promise<Runtime> {
    const key = keyFor(workspaceId, pluginId);
    return locked(key, async () => {
      if (closed || catalogMutationActive || mutatingPlugins.has(pluginId) || mutatingWorkspaces.has(workspaceId)) throw unavailable();
      if (!await readSpsWorkspacePresence(db, workspaceId)) throw unavailable();
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
      if (closed || catalogMutationActive || mutatingPlugins.has(pluginId) || mutatingWorkspaces.has(workspaceId)
        || authority.signal?.aborted || authority.boundWorkspaceId !== workspaceId) throw unavailable();
      await authority.assertCurrent();
      if (closed || catalogMutationActive || mutatingPlugins.has(pluginId) || mutatingWorkspaces.has(workspaceId)) throw unavailable();
      const epoch = await withSpsWorkspaceExecutionAdmission(db, workspaceId, async (_tx, admittedEpoch) => admittedEpoch);
      if (closed || catalogMutationActive || mutatingPlugins.has(pluginId) || mutatingWorkspaces.has(workspaceId)
        || authority.signal?.aborted) throw unavailable();
      const runtime = await ensure(workspaceId, pluginId, epoch);
      if (closed || catalogMutationActive || mutatingPlugins.has(pluginId) || mutatingWorkspaces.has(workspaceId)) throw unavailable();
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
    async reconcileWorkspacePolicy(workspaceId: string) {
      if (closed || !UUID.test(workspaceId)) throw unavailable();
      const keys = [...owners].filter(([, owner]) => owner.workspaceId === workspaceId).map(([key]) => key);
      try { await reconcileOwnerKeys(keys); }
      catch { throw unavailable(); }
    },
    async reconcileCatalogPolicy() {
      if (closed) throw unavailable();
      try { await runCatalogPolicySweep(); }
      catch { throw unavailable(); }
    },
    async withPluginMutation<T>(pluginId: string, action: () => Promise<T>): Promise<T> {
      if (closed || catalogMutationActive || mutatingWorkspaces.size > 0 || !UUID.test(pluginId)
        || typeof action !== "function" || mutatingPlugins.has(pluginId)) throw unavailable();
      mutatingPlugins.add(pluginId);
      return trackMutation(async () => {
        try {
          const keys = [...new Set([...owners.keys(), ...locks.keys()])]
            .filter(key => owners.get(key)?.pluginId === pluginId);
          try { await drainOwnerKeys(keys); }
          catch { throw unavailable(); }
          if (closed || catalogMutationActive || mutatingWorkspaces.size > 0) throw unavailable();
          return await action();
        } finally {
          mutatingPlugins.delete(pluginId);
        }
      });
    },
    withCatalogMutation<T>(action: () => Promise<T>): Promise<T> {
      if (closed || catalogMutationActive || mutatingPlugins.size > 0 || mutatingWorkspaces.size > 0 || typeof action !== "function") {
        return Promise.reject(unavailable());
      }
      catalogMutationActive = true;
      return trackMutation(async () => {
        try {
          const keys = [...new Set([...owners.keys(), ...locks.keys()])];
          try { await drainOwnerKeys(keys); }
          catch { throw unavailable(); }
          if (closed) throw unavailable();
          return await action();
        } finally {
          catalogMutationActive = false;
        }
      });
    },
    withWorkspaceMutation<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
      if (closed || catalogMutationActive || mutatingPlugins.size > 0 || !UUID.test(workspaceId)
        || typeof action !== "function" || mutatingWorkspaces.has(workspaceId)) return Promise.reject(unavailable());
      // Fence this owner synchronously before yielding, so no new A call/start
      // can slip between the company delete request and the exact-child drain.
      mutatingWorkspaces.add(workspaceId);
      return trackMutation(async () => {
        try {
          const keys = [...new Set([...owners.keys(), ...locks.keys()])]
            .filter(key => owners.get(key)?.workspaceId === workspaceId);
          try { await drainOwnerKeys(keys); }
          catch { throw unavailable(); }
          if (closed || catalogMutationActive || mutatingPlugins.size > 0) throw unavailable();
          return await action();
        } finally {
          mutatingWorkspaces.delete(workspaceId);
        }
      });
    },
    closeAdmission() { closed = true; },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      if (policySweepTimer) clearInterval(policySweepTimer);
      policySweepTimer = undefined;
      const attempt = (async () => {
        await Promise.allSettled([...mutationPromises]);
        // An already-running policy read may be needed to prove a runtime is
        // stale. Join it before shutdown drains every remaining exact child.
        await joinCatalogPolicySweeps();
        const selected = new Set([...runtimes.keys(), ...locks.keys(), ...owners.keys()]);
        const results = await Promise.allSettled([...selected].map(key => locked(key, async () => {
          const runtime = runtimes.get(key);
          if (runtime) await retire(key, runtime);
        })));
        if (results.some(result => result.status === "rejected")) throw unavailable();
        unregisterStop();
        if (factoryOwners.get(manager) === factoryOwner) factoryOwners.delete(manager);
      })();
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
