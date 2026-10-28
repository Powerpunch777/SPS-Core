/**
 * PluginWorkerManager — spawns and manages out-of-process plugin worker child
 * processes, routes JSON-RPC 2.0 calls over stdio, and handles lifecycle
 * management including crash recovery with exponential backoff.
 *
 * Each installed plugin gets one dedicated worker process. The host sends
 * JSON-RPC requests over the child's stdin and reads responses from stdout.
 * Worker stderr is captured and forwarded to the host logger.
 *
 * Process Model (from PLUGIN_SPEC.md §12):
 * - One worker process per installed plugin
 * - Failure isolation: plugin crashes do not affect the host
 * - Graceful shutdown: 10-second drain, then SIGTERM, then SIGKILL
 * - Automatic restart with exponential backoff on unexpected exits
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 * @see PLUGIN_SPEC.md §13 — Host-Worker Protocol
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  JSONRPC_VERSION,
  JSONRPC_ERROR_CODES,
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  createErrorResponse,
  parseMessage,
  serializeMessage,
  isJsonRpcResponse,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  JsonRpcParseError,
  JsonRpcCallError,
} from "@paperclipai/plugin-sdk";
import type {
  JsonRpcId,
  PluginInvocationContext,
  PluginInvocationScope,
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  WorkerHostCallContext,
  HostToWorkerMethodName,
  HostToWorkerMethods,
  WorkerToHostMethodName,
  WorkerToHostMethods,
  InitializeParams,
} from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { describeSpsHostSupport } from "./sps-host-support.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for RPC calls in milliseconds. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Hard upper bound for any RPC timeout (15 minutes). Prevents unbounded waits. */
const MAX_RPC_TIMEOUT_MS = 15 * 60 * 1_000;

/** Timeout for the initialize RPC call. */
const INITIALIZE_TIMEOUT_MS = 15_000;

/** Timeout for the shutdown RPC call before escalating to SIGTERM. */
const SHUTDOWN_DRAIN_MS = 10_000;

/** Time to wait after SIGTERM before sending SIGKILL. */
const SIGTERM_GRACE_MS = 5_000;

/** Minimum backoff delay for crash recovery (1 second). */
const MIN_BACKOFF_MS = 1_000;

/** Maximum backoff delay for crash recovery (5 minutes). */
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Backoff multiplier on each consecutive crash. */
const BACKOFF_MULTIPLIER = 2;

/** Maximum number of consecutive crashes before giving up on auto-restart. */
const MAX_CONSECUTIVE_CRASHES = 10;
const MAX_STREAM_CHANNELS_PER_WORKER = 64;
const MAX_STREAM_SELECTOR_LENGTH = 256;
const MAX_QUEUED_STREAM_NOTIFICATIONS = 1_024;

/** Time window in which crashes are considered consecutive (10 minutes). */
const CRASH_WINDOW_MS = 10 * 60 * 1_000;

/** Maximum number of stderr characters retained for worker failure context. */
const MAX_STDERR_EXCERPT_CHARS = 8_000;

/** Reserved namespace lets late guarded IDs fail closed without retaining history. */
const GUARDED_INVOCATION_PREFIX = "sps-guarded:";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status of a managed worker process.
 */
export type WorkerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "backoff";

/**
 * Worker-to-host method handler. The host registers these to service calls
 * that the plugin worker makes back to the host (e.g. state.get, events.emit).
 */
export type WorkerToHostHandler<M extends WorkerToHostMethodName> = (
  params: WorkerToHostMethods[M][0],
  context?: WorkerHostCallContext,
) => Promise<WorkerToHostMethods[M][1]>;

/**
 * A map of all worker-to-host method handlers provided by the host.
 */
export type WorkerToHostHandlers = {
  [M in WorkerToHostMethodName]?: WorkerToHostHandler<M>;
};

/**
 * Events emitted by a PluginWorkerHandle.
 */
export interface WorkerHandleEvents {
  /** Worker process started and is ready (initialize succeeded). */
  "ready": { pluginId: string };
  /** Worker process exited. */
  "exit": { pluginId: string; code: number | null; signal: NodeJS.Signals | null };
  /** Worker process crashed unexpectedly. */
  "crash": { pluginId: string; code: number | null; signal: NodeJS.Signals | null; willRestart: boolean };
  /** Worker process errored (e.g. spawn failure). */
  "error": { pluginId: string; error: Error };
  /** Worker status changed. */
  "status": { pluginId: string; status: WorkerStatus; previousStatus: WorkerStatus };
}

type WorkerHandleEventName = keyof WorkerHandleEvents;

export function appendStderrExcerpt(current: string, chunk: string): string {
  const next = current ? `${current}\n${chunk}` : chunk;
  return next.length <= MAX_STDERR_EXCERPT_CHARS
    ? next
    : next.slice(-MAX_STDERR_EXCERPT_CHARS);
}

export function formatWorkerFailureMessage(message: string, stderrExcerpt: string): string {
  const excerpt = stderrExcerpt.trim();
  if (!excerpt) return message;
  if (message.includes(excerpt)) return message;
  return `${message}\n\nWorker stderr:\n${excerpt}`;
}

/**
 * Options for starting a worker process.
 */
export interface WorkerStartOptions {
  /** Absolute path to the plugin worker entrypoint (CJS bundle). */
  entrypointPath: string;
  /** Plugin manifest. */
  manifest: PaperclipPluginManifestV1;
  /** Resolved plugin configuration. */
  config: Record<string, unknown>;
  /** Host instance information for the initialize call. */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
  /** Host-derived plugin database namespace, when declared. */
  databaseNamespace?: string | null;
  /** Handlers for worker→host RPC calls. */
  hostHandlers: WorkerToHostHandlers;
  /** Default timeout for RPC calls (ms). Defaults to 30s. */
  rpcTimeoutMs?: number;
  /** Whether to auto-restart on crash. Defaults to true. */
  autoRestart?: boolean;
  /** Node.js execArgv passed to the child process. */
  execArgv?: string[];
  /** Environment variables passed to the child process. */
  env?: Record<string, string>;
  /**
   * Callback for stream notifications from the worker (streams.open/emit/close).
   * The host wires this to the PluginStreamBus to fan out events to SSE clients.
   */
  onStreamNotification?: (
    method: string,
    params: Record<string, unknown>,
    ownerGeneration: string,
    canPublish: () => boolean,
  ) => void | Promise<void>;
}

interface WorkerOwner {
  readonly workspaceId: string | null;
  readonly pluginId: string;
}

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function workerOwnerKey(owner: WorkerOwner): string {
  return JSON.stringify([owner.workspaceId, owner.pluginId]);
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new TypeError("Workspace worker requires a valid Workspace ID");
}

/**
 * A pending RPC call waiting for a response from the worker.
 */
interface PendingRequest {
  /** The request ID. */
  id: JsonRpcId;
  /** Method name (for logging). */
  method: string;
  /** Resolve the promise with the response. */
  resolve: (response: JsonRpcResponse) => void;
  /** Timeout timer handle. */
  timer: ReturnType<typeof setTimeout>;
  /** Timestamp when the request was sent. */
  sentAt: number;
  /** Active host-owned invocation id attached to this host→worker call. */
  invocationId?: string;
  /** Caller cancellation suppresses the result; the wire request remains accounted for. */
  deliveryCancelled?: boolean;
  /** A matching response was buffered before process close; still checking its authority. */
  responseReceived?: boolean;
  /** Removes the abort listener after the RPC actually settles. */
  removeAbortListener?: () => void;
  onTerminal?: (reason: "response" | "worker_exit" | "not_dispatched") => void;
  terminalNotified?: boolean;
  timedOut?: boolean;
}

/** Host-only authority for one Native invocation; never included in RPC payloads. */
export interface WorkerInvocationAuthority {
  assertCurrent: () => void | Promise<void>;
  /** Trusted Workspace selected by the Host, independently of RPC parameters. Never serialized. */
  readonly boundWorkspaceId?: string;
  signal?: AbortSignal;
  /** Allows an exact Host runJob invocation (scope `{}`) to use host authority fencing. */
  allowHostInvocation?: boolean;
  /** Fires only when the worker returns the actual RPC response or exits. A local timeout is not a terminal acknowledgement. */
  onTerminal?: (reason: "response" | "worker_exit" | "not_dispatched") => void;
  readNativeConnectivity?: NonNullable<WorkerHostCallContext["readNativeConnectivity"]>;
}

interface ActiveInvocation {
  scope: PluginInvocationScope;
  authority?: WorkerInvocationAuthority;
  invalidated?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// PluginWorkerHandle — manages a single worker process
// ---------------------------------------------------------------------------

/**
 * Handle for a single plugin worker process.
 *
 * Callers use `start()` to spawn the worker, `call()` to send RPC requests,
 * and `stop()` to gracefully shut down. The handle manages crash recovery
 * with exponential backoff automatically when `autoRestart` is enabled.
 */
export interface PluginWorkerHandle {
  /** The plugin ID this worker serves. */
  readonly pluginId: string;

  /** Workspace owner for scoped workers; omitted for the legacy Host worker. */
  readonly workspaceId?: string;

  /** Current worker status. */
  readonly status: WorkerStatus;

  /** Start the worker process. Resolves when initialize completes. */
  start(): Promise<void>;

  /**
   * Stop the worker process gracefully.
   *
   * Sends a `shutdown` RPC call, waits up to 10 seconds for the worker to
   * exit, then escalates to SIGTERM, and finally SIGKILL if needed.
   */
  stop(): Promise<void>;

  /**
   * Restart the worker process (stop + start).
   */
  restart(): Promise<void>;

  /**
   * Send a typed host→worker RPC call.
   *
   * @param method - The RPC method name
   * @param params - Method parameters
   * @param timeoutMs - Optional per-call timeout override
   * @returns The method result
   * @throws {JsonRpcCallError} if the worker returns an error response
   * @throws {Error} if the worker is not running or the call times out
   */
  call<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    authority?: WorkerInvocationAuthority,
    terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
  ): Promise<HostToWorkerMethods[M][1]>;

  /**
   * Send a fire-and-forget notification to the worker (no response expected).
   */
  notify(method: string, params: unknown): void;

  /** Subscribe to worker events. */
  on<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Unsubscribe from worker events. */
  off<K extends WorkerHandleEventName>(
    event: K,
    listener: (payload: WorkerHandleEvents[K]) => void,
  ): void;

  /** Optional methods the worker reported during initialization. */
  readonly supportedMethods: string[];

  /** Get diagnostic info about the worker. */
  diagnostics(): WorkerDiagnostics;
}

/**
 * Diagnostic information about a worker process.
 */
export interface WorkerDiagnostics {
  pluginId: string;
  workspaceId?: string;
  status: WorkerStatus;
  pid: number | null;
  uptime: number | null;
  consecutiveCrashes: number;
  totalCrashes: number;
  pendingRequests: number;
  lastCrashAt: number | null;
  nextRestartAt: number | null;
}

// ---------------------------------------------------------------------------
// PluginWorkerManager — manages all plugin workers
// ---------------------------------------------------------------------------

/**
 * The top-level manager that holds all plugin worker handles.
 *
 * Provides a registry of workers keyed by plugin ID, with convenience methods
 * for starting/stopping all workers and routing RPC calls.
 */
export interface PluginWorkerManager {
  /**
   * Register and start a worker for a plugin.
   *
   * @returns The worker handle
   * @throws if a worker is already registered for this plugin
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle>;

  /** Start a worker owned by exactly one Workspace and Plugin. */
  startWorkspaceWorker(workspaceId: string, pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle>;

  /**
   * Stop and unregister a specific plugin worker.
   */
  stopWorker(pluginId: string): Promise<void>;

  /** Stop matching Workspace workers, leaving other Workspaces untouched. */
  stopWorkspaceWorkers(workspaceId: string, pluginId?: string): Promise<void>;

  /**
   * Get the worker handle for a plugin.
   */
  getWorker(pluginId: string): PluginWorkerHandle | undefined;

  /** Get only the worker owned by this Workspace and Plugin pair. */
  getWorkspaceWorker(workspaceId: string, pluginId: string): PluginWorkerHandle | undefined;

  /**
   * Check if a worker is registered and running for a plugin.
   */
  isRunning(pluginId: string): boolean;

  /**
   * Stop all current workers while temporarily fencing new starts.
   * Reusable after completion; failed workers remain tracked and reject the call.
   */
  stopAll(): Promise<void>;

  /**
   * Permanently close this manager and stop all managed workers.
   * New workers are rejected once shutdown begins.
   */
  shutdown(): Promise<void>;

  /**
   * Get diagnostic info for all workers.
   */
  diagnostics(): WorkerDiagnostics[];

  /**
   * Send an RPC call to a specific plugin worker.
   *
   * @throws if the worker is not running
   */
  call<M extends HostToWorkerMethodName>(
    pluginId: string,
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    authority?: WorkerInvocationAuthority,
    terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
  ): Promise<HostToWorkerMethods[M][1]>;

  /** Call a Workspace-owned UI/data/action handler using Host-verified authority. */
  callWorkspaceWorker<M extends HostToWorkerMethodName>(
    workspaceId: string,
    pluginId: string,
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    authority?: WorkerInvocationAuthority,
    terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
  ): Promise<HostToWorkerMethods[M][1]>;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerHandle
// ---------------------------------------------------------------------------

/**
 * Create a handle for a single plugin worker process.
 *
 * @internal Exported for testing; consumers should use `createPluginWorkerManager`.
 */
export function createPluginWorkerHandle(
  pluginId: string,
  options: WorkerStartOptions,
  canStart: () => boolean = () => true,
): PluginWorkerHandle {
  return createPluginWorkerHandleInternal(pluginId, options, canStart);
}

function createPluginWorkerHandleInternal(
  pluginId: string,
  options: WorkerStartOptions,
  canStart: () => boolean,
  ownerWorkspaceId?: string,
): PluginWorkerHandle {
  const log = logger.child({ service: "plugin-worker", pluginId, ...(ownerWorkspaceId ? { workspaceId: ownerWorkspaceId } : {}) });
  const emitter = new EventEmitter();
  /**
   * Higher than default (10) to accommodate multiple subscribers to
   * crash/ready/exit events during integration tests and runtime monitoring.
   */
  emitter.setMaxListeners(50);

  // Worker process state
  let childProcess: ChildProcess | null = null;
  let processExited = false;
  let processClosePromise: Promise<void> | null = null;
  let resolveProcessClose: (() => void) | null = null;
  let pendingCrash: { code: number | null; signal: NodeJS.Signals | null; willRestart: boolean } | null = null;
  let readline: ReadlineInterface | null = null;
  let stderrReadline: ReadlineInterface | null = null;
  let status: WorkerStatus = "stopped";
  let startedAt: number | null = null;
  let stderrExcerpt = "";

  // Pending RPC requests awaiting a response
  const pendingRequests = new Map<string | number, PendingRequest>();
  let nextRequestId = 1;
  const activeInvocations = new Map<string, ActiveInvocation>();
  const streamNotificationQueues = new WeakMap<ChildProcess, {
    tail: Promise<void>;
    queued: number;
    overflowed: boolean;
  }>();
  const lateTerminalAcks = new Map<string | number, { invocationId: string; onTerminal: (reason: "response" | "worker_exit" | "not_dispatched") => void }>();
  // Optional methods reported by the worker during initialization
  let supportedMethods: string[] = [];
  let initializing = false;

  // Crash tracking for exponential backoff
  let consecutiveCrashes = 0;
  let totalCrashes = 0;
  let lastCrashAt: number | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRestartAt: number | null = null;

  // Track stream subscriptions by the complete tenant/channel tuple so two
  // Workspaces using the same plugin channel cannot overwrite each other.
  const openStreamChannels = new Map<string, { channel: string; companyId: string; invocationId?: string }>();
  let streamOwnerGeneration: string | null = null;
  const retiredStreamGenerations = new Set<string>();
  const retiredStreamGenerationOrder: string[] = [];

  // Shutdown coordination
  let intentionalStop = false;
  let stopPromise: Promise<void> | null = null;

  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const autoRestart = options.autoRestart ?? true;

  // -----------------------------------------------------------------------
  // Status management
  // -----------------------------------------------------------------------

  function setStatus(newStatus: WorkerStatus): void {
    const prev = status;
    if (prev === newStatus) return;
    status = newStatus;
    log.debug({ from: prev, to: newStatus }, "worker status change");
    emitter.emit("status", { pluginId, status: newStatus, previousStatus: prev });
  }

  // -----------------------------------------------------------------------
  // JSON-RPC message sending
  // -----------------------------------------------------------------------

  function sendMessage(message: unknown): void {
    if (processExited || !childProcess?.stdin?.writable) {
      throw new Error(`Worker process for plugin "${pluginId}" is not writable`);
    }
    const serialized = serializeMessage(message as any);
    childProcess.stdin.write(serialized);
  }

  function errorCodeForWorkerHostError(err: unknown): number {
    const code = (err as { code?: unknown } | null)?.code;
    const pluginErrorCodes: readonly number[] = Object.values(PLUGIN_RPC_ERROR_CODES);
    return typeof code === "number" && pluginErrorCodes.includes(code)
      ? code
      : JSONRPC_ERROR_CODES.INTERNAL_ERROR;
  }

  // -----------------------------------------------------------------------
  // Incoming message handling
  // -----------------------------------------------------------------------

  function handleLine(line: string, sourceChild: ChildProcess): void {
    if (!line.trim()) return;
    if (childProcess !== sourceChild) return;

    let message: unknown;
    try {
      message = parseMessage(line);
    } catch (err) {
      if (err instanceof JsonRpcParseError) {
        log.warn({ rawLine: line.slice(0, 200) }, "unparseable message from worker");
      } else {
        log.warn({ err }, "error parsing worker message");
      }
      return;
    }

    if (isJsonRpcResponse(message)) {
      void handleResponse(message, sourceChild);
    } else if (isJsonRpcRequest(message)) {
      if (processExited) return;
      handleWorkerRequest(message as JsonRpcRequest);
    } else if (isJsonRpcNotification(message)) {
      if (processExited) return;
      const notification = message as JsonRpcNotification;
      if (notification.method === "streams.open" || notification.method === "streams.emit" || notification.method === "streams.close") {
        const queue = streamQueueFor(sourceChild);
        if (queue.overflowed) return;
        if (queue.queued >= MAX_QUEUED_STREAM_NOTIFICATIONS) {
          overflowStreamNotifications(sourceChild, queue);
          return;
        }
        enqueueStreamTask(sourceChild, () => handleWorkerNotification(notification, sourceChild));
      } else {
        void handleWorkerNotification(notification, sourceChild);
      }
    } else {
      log.warn("unknown message type from worker");
    }
  }

  /**
   * Handle a JSON-RPC response from the worker (matching a pending request).
   */
  async function handleResponse(response: JsonRpcResponse, sourceChild: ChildProcess): Promise<void> {
    const id = response.id;
    if (id === null || id === undefined) {
      log.warn("received response with null/undefined id");
      return;
    }

    const pending = pendingRequests.get(id);
    if (!pending) {
      const late = lateTerminalAcks.get(id);
      if (late) {
        lateTerminalAcks.delete(id);
        const entry = activeInvocations.get(late.invocationId);
        if (entry?.timer) clearTimeout(entry.timer);
        activeInvocations.delete(late.invocationId);
        void Promise.resolve(late.onTerminal("response")).catch(() => undefined);
        return;
      }
      log.warn({ id }, "received response for unknown request id");
      return;
    }

    pending.responseReceived = true;
    notifyTerminal(pending, "response");
    const invocation = pending.invocationId ? activeInvocations.get(pending.invocationId) : undefined;

    // Notifications and the matching RPC response share stdout ordering. Drain
    // all earlier stream callbacks before settling the invocation they belong to.
    // Mark receipt first so a later child exit preserves this buffered response.
    await streamQueueFor(sourceChild).tail;
    if (pendingRequests.get(id) !== pending) return;

    if (pending.deliveryCancelled) {
      pending.resolve(createErrorResponse(
        response.id,
        PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        "Plugin invocation authority is no longer current",
      ) as JsonRpcResponse);
      return;
    }
    if (invocation?.authority) {
      try {
        await assertInvocationCurrent(invocation);
      } catch {
        pending.resolve(createErrorResponse(
          response.id,
          PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          "Plugin invocation authority is no longer current",
        ) as JsonRpcResponse);
        return;
      }
    }
    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.removeAbortListener?.();
    pending.resolve(response);
  }

  function readNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function deriveInvocationScope(
    method: HostToWorkerMethodName | string,
    params: unknown,
  ): PluginInvocationScope | null {
    if (!isRecord(params)) return null;

    const directCompanyId = readNonEmptyString(params.companyId);
    if (directCompanyId) return { companyId: directCompanyId };

    if (method === "performAction" && isRecord(params.actorContext)) {
      const companyId = readNonEmptyString(params.actorContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "executeTool" && isRecord(params.runContext)) {
      const companyId = readNonEmptyString(params.runContext.companyId);
      return companyId ? { companyId } : null;
    }

    if (method === "onEvent" && isRecord(params.event)) {
      const companyId = readNonEmptyString(params.event.companyId);
      return companyId ? { companyId } : null;
    }

    // Workspace jobs carry their tenant inside the job envelope. Legacy Host
    // jobs have no tenant, but still need an explicit invocation identity.
    if (method === "runJob") {
      const companyId = isRecord(params.job) ? readNonEmptyString(params.job.companyId) : null;
      return companyId ? { companyId } : {};
    }

    return null;
  }

  function invocationDenied(): JsonRpcCallError {
    return new JsonRpcCallError({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      message: "Plugin invocation authority is no longer current",
    });
  }

  function notifyTerminal(
    pending: PendingRequest,
    reason: "response" | "worker_exit" | "not_dispatched",
  ): void {
    if (!pending.onTerminal || pending.terminalNotified) return;
    pending.terminalNotified = true;
    void Promise.resolve(pending.onTerminal(reason)).catch(() => undefined);
  }

  function matchesBoundWorkspace(scope: PluginInvocationScope | null, authority: WorkerInvocationAuthority): boolean {
    const bound = authority.boundWorkspaceId;
    return bound === undefined || (typeof bound === "string"
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bound)
      && scope?.companyId === bound);
  }

  function matchesBoundCall(method: HostToWorkerMethodName, params: unknown, authority: WorkerInvocationAuthority): boolean {
    if (!matchesBoundWorkspace(deriveInvocationScope(method, params), authority)) return false;
    if (ownerWorkspaceId !== undefined && authority.boundWorkspaceId !== ownerWorkspaceId) return false;
    if (authority.boundWorkspaceId === undefined || !isRecord(params)) return true;
    // A direct companyId must not conceal a contradictory authenticated
    // actor/tool/job/event envelope used by the receiving worker.
    const envelope = method === "performAction" ? params.actorContext
      : method === "executeTool" ? params.runContext
      : method === "runJob" ? params.job
      : method === "onEvent" ? params.event : undefined;
    if (ownerWorkspaceId !== undefined && method === "performAction") {
      return isRecord(envelope) && envelope.companyId === ownerWorkspaceId;
    }
    return envelope === undefined || (isRecord(envelope) && envelope.companyId === authority.boundWorkspaceId);
  }

  async function assertAuthorityCurrent(authority: WorkerInvocationAuthority): Promise<void> {
    const signal = authority.signal;
    if (signal?.aborted) throw invocationDenied();
    let abortListener: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(invocationDenied());
        signal.addEventListener("abort", abortListener, { once: true });
      })
      : null;
    try {
      const check = Promise.resolve().then(() => authority.assertCurrent());
      if (aborted) await Promise.race([check, aborted]);
      else await check;
    } catch {
      throw invocationDenied();
    } finally {
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
    if (signal?.aborted) throw invocationDenied();
  }

  async function assertInvocationCurrent(invocation: ActiveInvocation): Promise<void> {
    if (invocation.invalidated || invocation.authority?.signal?.aborted) {
      throw invocationDenied();
    }
    if (invocation.authority) {
      try {
        if (!matchesBoundWorkspace(invocation.scope, invocation.authority)) throw invocationDenied();
        await assertAuthorityCurrent(invocation.authority);
        if (!matchesBoundWorkspace(invocation.scope, invocation.authority)) throw invocationDenied();
      } catch {
        invocation.invalidated = true;
        throw invocationDenied();
      }
      if (invocation.invalidated || invocation.authority.signal?.aborted) {
        throw invocationDenied();
      }
    }
  }

  function registerInvocation(
    scope: PluginInvocationScope,
    ttlMs?: number,
    authority?: WorkerInvocationAuthority,
  ): PluginInvocationContext {
    const registeredScope = authority?.boundWorkspaceId !== undefined ? Object.freeze({ ...scope }) : scope;
    const invocation: PluginInvocationContext = {
      id: authority ? `${GUARDED_INVOCATION_PREFIX}${randomUUID()}` : randomUUID(),
      scope: registeredScope,
    };
    const entry: ActiveInvocation = { scope: registeredScope, authority };
    if (ttlMs !== undefined) {
      entry.timer = setTimeout(() => {
        const current = activeInvocations.get(invocation.id);
        if (!current) return;
        if (current.authority) {
          current.invalidated = true;
          if (ownerWorkspaceId !== undefined) closeInvocationStreams(invocation.id);
        } else {
          activeInvocations.delete(invocation.id);
        }
      }, ttlMs);
      if (entry.timer.unref) entry.timer.unref();
    }
    activeInvocations.set(invocation.id, entry);
    return invocation;
  }

  function clearInvocation(invocation: PluginInvocationContext | null): void {
    if (!invocation) return;
    if (ownerWorkspaceId !== undefined) closeInvocationStreams(invocation.id);
    const entry = activeInvocations.get(invocation.id);
    if (entry?.timer) clearTimeout(entry.timer);
    activeInvocations.delete(invocation.id);
  }

  function closeInvocationStreams(invocationId: string): void {
    if (!options.onStreamNotification || !streamOwnerGeneration) return;
    const generation = streamOwnerGeneration;
    const child = childProcess;
    if (!child) return;
    for (const [key, stream] of openStreamChannels) {
      if (stream.invocationId !== invocationId) continue;
      openStreamChannels.delete(key);
      enqueueStreamTask(child, () => Promise.resolve(options.onStreamNotification!(
          "streams.close",
          { channel: stream.channel, companyId: stream.companyId },
          generation,
          () => childProcess === child && streamOwnerGeneration === generation
            && !openStreamChannels.has(key),
        )).then(() => undefined));
    }
  }

  function streamQueueFor(child: ChildProcess): { tail: Promise<void>; queued: number; overflowed: boolean } {
    let queue = streamNotificationQueues.get(child);
    if (!queue) {
      queue = { tail: Promise.resolve(), queued: 0, overflowed: false };
      streamNotificationQueues.set(child, queue);
    }
    return queue;
  }

  function enqueueStreamTask(child: ChildProcess, task: () => Promise<void> | void): void {
    const queue = streamQueueFor(child);
    queue.queued++;
    queue.tail = queue.tail.then(task).catch(() => undefined).finally(() => { queue.queued--; });
  }

  function overflowStreamNotifications(
    child: ChildProcess,
    queue: { tail: Promise<void>; queued: number; overflowed: boolean },
  ): void {
    if (queue.overflowed) return;
    queue.overflowed = true;
    const generation = streamOwnerGeneration;
    const streams = Array.from(openStreamChannels.entries());
    for (const [key] of streams) openStreamChannels.delete(key);
    if (!generation || !options.onStreamNotification) return;
    for (const [key, stream] of streams) {
      enqueueStreamTask(child, () => Promise.resolve(options.onStreamNotification!(
        "streams.close",
        { channel: stream.channel, companyId: stream.companyId },
        generation,
        () => childProcess === child && streamOwnerGeneration === generation && !openStreamChannels.has(key),
      )).then(() => undefined));
    }
  }

  function rememberRetiredStreamGeneration(generation: string): void {
    if (retiredStreamGenerations.has(generation)) return;
    retiredStreamGenerations.add(generation);
    retiredStreamGenerationOrder.push(generation);
    while (retiredStreamGenerationOrder.length > 64) {
      const oldest = retiredStreamGenerationOrder.shift();
      if (oldest) retiredStreamGenerations.delete(oldest);
    }
  }

  function nativeConnectivityContext(invocationId: string, entry: ActiveInvocation): Pick<WorkerHostCallContext, "readNativeConnectivity"> {
    if (!entry.authority?.readNativeConnectivity) return {};
    return {
      readNativeConnectivity: async () => {
        if (activeInvocations.get(invocationId) !== entry) throw invocationDenied();
        await assertInvocationCurrent(entry);
        const result = await entry.authority!.readNativeConnectivity!();
        await assertInvocationCurrent(entry);
        if (activeInvocations.get(invocationId) !== entry) throw invocationDenied();
        return result;
      },
    };
  }

  async function contextForWorkerMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<WorkerHostCallContext> {
    const method = message.method;
    const invocationId = readNonEmptyString(
      (message as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );

    if (ownerWorkspaceId !== undefined) {
      if (!invocationId) {
        // Setup may read only its already Workspace-bound startup config. All
        // other worker→Host requests require a live Host-created invocation.
        if (initializing && method === "config.get") {
          return { invocationScope: { companyId: ownerWorkspaceId } };
        }
        return { invalidInvocationScope: true };
      }
      const ownedEntry = activeInvocations.get(invocationId);
      if (!ownedEntry?.authority
        || ownedEntry.authority.boundWorkspaceId !== ownerWorkspaceId
        || ownedEntry.scope.companyId !== ownerWorkspaceId) {
        return { invalidInvocationScope: true };
      }
      try {
        await assertInvocationCurrent(ownedEntry);
      } catch {
        return { invalidInvocationScope: true };
      }
      return { invocationScope: ownedEntry.scope, ...nativeConnectivityContext(invocationId, ownedEntry) };
    }

    if (invocationId?.startsWith(GUARDED_INVOCATION_PREFIX) && !activeInvocations.get(invocationId)?.authority) {
      return { invalidInvocationScope: true };
    }
    if (!invocationId) {
      const hasActiveInvocation = activeInvocations.size > 0 ||
        Array.from(pendingRequests.values()).some((pending) => pending.invocationId);
      return hasActiveInvocation ? { invalidInvocationScope: true } : {};
    }
    const entry = activeInvocations.get(invocationId);
    if (!entry) return { invalidInvocationScope: true };
    if (entry.authority) {
      try {
        await assertInvocationCurrent(entry);
      } catch {
        return { invalidInvocationScope: true };
      }
    }
    return { invocationScope: entry.scope, ...nativeConnectivityContext(invocationId, entry) };
  }

  /**
   * Handle a JSON-RPC request from the worker (worker→host call).
   */
  async function handleWorkerRequest(request: JsonRpcRequest): Promise<void> {
    const requestChild = childProcess;
    if (!requestChild || processExited) return;
    const method = request.method as WorkerToHostMethodName;
    const invocationId = readNonEmptyString(
      (request as { paperclipInvocationId?: unknown }).paperclipInvocationId,
    );
    const hasGuardedInvocation = Array.from(activeInvocations.values()).some((entry) => entry.authority);
    const context = await contextForWorkerMessage(request);
    if (childProcess !== requestChild || processExited) return;
    if (context.invalidInvocationScope && (ownerWorkspaceId !== undefined || hasGuardedInvocation || invocationId?.startsWith(GUARDED_INVOCATION_PREFIX))) {
      try {
        sendMessage(createErrorResponse(
          request.id,
          PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          "Plugin invocation authority is no longer current",
        ));
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }
    const invocation = invocationId ? activeInvocations.get(invocationId) : undefined;
    const handler = options.hostHandlers[method] as
      | ((params: unknown, context?: WorkerHostCallContext) => Promise<unknown>)
      | undefined;

    if (!handler) {
      log.warn({ method }, "worker called unregistered host method");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Host does not handle method "${method}"`,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
      return;
    }

    try {
      const result = await handler(request.params, context);
      if (invocation?.authority) await assertInvocationCurrent(invocation);
      if (childProcess !== requestChild || processExited) return;
      sendMessage({
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      });
    } catch (err) {
      if (childProcess !== requestChild || processExited) return;
      const denied = invocation?.authority && (invocation.invalidated || invocation.authority.signal?.aborted);
      const errorMessage = denied
        ? "Plugin invocation authority is no longer current"
        : (err instanceof Error ? err.message : String(err));
      if (denied) {
        try {
          sendMessage(createErrorResponse(request.id, PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED, errorMessage));
        } catch {
          // Worker may have exited, ignore send error
        }
        return;
      }
      log.error({ method, err: errorMessage }, "host handler error");
      try {
        sendMessage(
          createErrorResponse(
            request.id,
            errorCodeForWorkerHostError(err),
            errorMessage,
          ),
        );
      } catch {
        // Worker may have exited, ignore send error
      }
    }
  }

  /**
   * Handle a JSON-RPC notification from the worker (fire-and-forget).
   *
   * The `log` notification is the primary case — worker `ctx.logger` calls
   * arrive here. We append structured plugin context (pluginId, timestamp,
   * level) so that every log entry is queryable per the spec (§26.1).
   */
  async function handleWorkerNotification(notification: JsonRpcNotification, notificationChild: ChildProcess): Promise<void> {
    const notificationGeneration = streamOwnerGeneration;
    if (!notificationChild || processExited) return;
    if (notification.method === "log") {
      const params = notification.params as {
        level?: string;
        message?: string;
        meta?: Record<string, unknown>;
      } | null;
      const level = params?.level ?? "info";
      const msg = params?.message ?? "";
      const meta = params?.meta;

      // Build a structured log object that includes the plugin context fields
      // required by §26.1: pluginId, timestamp, level, message, and metadata.
      // The child logger already carries `pluginId` in its bindings, but we
      // add explicit `pluginLogLevel` and `pluginTimestamp` so downstream
      // consumers (log storage, UI queries) can filter without parsing.
      const logFields: Record<string, unknown> = {
        ...meta,
        pluginLogLevel: level,
        pluginTimestamp: new Date().toISOString(),
      };

      if (level === "error") {
        log.error(logFields, `[plugin] ${msg}`);
      } else if (level === "warn") {
        log.warn(logFields, `[plugin] ${msg}`);
      } else if (level === "debug") {
        log.debug(logFields, `[plugin] ${msg}`);
      } else {
        log.info(logFields, `[plugin] ${msg}`);
      }
      return;
    }

    // Stream notifications: forward to the stream bus via callback
    if (
      notification.method === "streams.open" ||
      notification.method === "streams.emit" ||
      notification.method === "streams.close"
    ) {
      if (streamQueueFor(notificationChild).overflowed) return;
      const params = (notification.params ?? {}) as Record<string, unknown>;
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      const invocationId = readNonEmptyString(
        (notification as { paperclipInvocationId?: unknown }).paperclipInvocationId,
      );
      const context = await contextForWorkerMessage(notification);
      if (childProcess !== notificationChild || processExited || streamOwnerGeneration !== notificationGeneration
        || streamQueueFor(notificationChild).overflowed) return;
      if (context.invalidInvocationScope) {
        // Do not log worker-controlled payload values for denied notifications.
        return;
      }
      const invocation = invocationId ? activeInvocations.get(invocationId) : undefined;
      if (!notificationGeneration) return;
      if (ownerWorkspaceId !== undefined
        && (!invocationId || !invocation?.authority
          || invocation.authority.boundWorkspaceId !== ownerWorkspaceId
          || invocation.scope.companyId !== ownerWorkspaceId)) return;
      const allowedCompanyId = context.invocationScope?.companyId;
      if (allowedCompanyId && companyId !== allowedCompanyId) {
        log.warn(
          { method: notification.method, companyId, allowedCompanyId },
          "dropping plugin stream notification outside invocation company scope",
        );
        return;
      }

      if (invocation) {
        try {
          await assertInvocationCurrent(invocation);
        } catch {
          return;
        }
      }
      if (childProcess !== notificationChild || processExited
        || streamOwnerGeneration !== notificationGeneration
        || (invocationId !== null && activeInvocations.get(invocationId) !== invocation)) return;

      const channel = typeof params.channel === "string" ? params.channel : "";
      const validStreamSelector = (value: string): boolean => value.length > 0
        && value.length <= MAX_STREAM_SELECTOR_LENGTH
        && !/[\u0000-\u001f\u007f]/.test(value);
      if (!validStreamSelector(channel) || !validStreamSelector(companyId)) return;
      const streamKey = JSON.stringify([companyId, channel]);
      const currentStream = openStreamChannels.get(streamKey);
      if (notification.method === "streams.open") {
        if (currentStream && currentStream.invocationId !== (ownerWorkspaceId !== undefined ? invocationId : undefined)) return;
        if (!currentStream && openStreamChannels.size >= MAX_STREAM_CHANNELS_PER_WORKER) return;
        openStreamChannels.set(streamKey, {
          channel,
          companyId,
          ...(ownerWorkspaceId !== undefined && invocationId ? { invocationId } : {}),
        });
      } else if (!currentStream
        || currentStream.invocationId !== (ownerWorkspaceId !== undefined ? invocationId : undefined)) {
        return;
      } else if (notification.method === "streams.close") {
        openStreamChannels.delete(streamKey);
      }

      if (options.onStreamNotification) {
        try {
          const canPublish = (): boolean => {
            if (notification.method === "streams.close") {
              return streamOwnerGeneration === notificationGeneration
                || retiredStreamGenerations.has(notificationGeneration);
            }
            const trackedStream = openStreamChannels.get(streamKey);
            return childProcess === notificationChild && !processExited
              && streamOwnerGeneration === notificationGeneration
              && !streamQueueFor(notificationChild).overflowed
              && trackedStream !== undefined
              && trackedStream.invocationId === (ownerWorkspaceId !== undefined ? invocationId : undefined)
              && (invocationId === null || (
                activeInvocations.get(invocationId) === invocation
                && !invocation?.invalidated
                && !invocation?.authority?.signal?.aborted
              ));
          };
          await options.onStreamNotification(notification.method, params, notificationGeneration, canPublish);
          if (childProcess !== notificationChild || processExited || streamOwnerGeneration !== notificationGeneration) return;
          if (invocation && activeInvocations.get(invocationId!) !== invocation) return;
          if (invocation) await assertInvocationCurrent(invocation);
        } catch (err) {
          if (!invocation?.authority) {
            log.error(
              {
                method: notification.method,
                err: err instanceof Error ? err.message : String(err),
              },
              "stream notification handler failed",
            );
          }
        }
      }
      return;
    }

    log.debug({ method: notification.method }, "received notification from worker");
  }

  // -----------------------------------------------------------------------
  // Process lifecycle
  // -----------------------------------------------------------------------

  function spawnProcess(): ChildProcess {
    // Security: Do NOT spread process.env into the worker. Plugins should only
    // receive a minimal, controlled environment to prevent leaking host
    // secrets (like DATABASE_URL, internal API keys, etc.).
    const workerEnv: Record<string, string> = {
      ...options.env,
      PATH: process.env.PATH ?? "",
      NODE_PATH: process.env.NODE_PATH ?? "",
      PAPERCLIP_PLUGIN_ID: pluginId,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      TZ: process.env.TZ ?? "UTC",
    };

    const child = fork(options.entrypointPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      execArgv: options.execArgv ?? [],
      env: workerEnv,
      // Don't let the child keep the parent alive
      detached: false,
    });

    streamOwnerGeneration = randomUUID();

    return child;
  }

  function attachStdioHandlers(child: ChildProcess): void {
    // Read NDJSON from stdout
    if (child.stdout) {
      readline = createInterface({ input: child.stdout });
      readline.on("line", (line: string) => handleLine(line, child));
    }

    // Capture stderr for logging
    if (child.stderr) {
      stderrReadline = createInterface({ input: child.stderr });
      stderrReadline.on("line", (line: string) => {
        stderrExcerpt = appendStderrExcerpt(stderrExcerpt, line);
        log.warn({ stream: "stderr" }, `[plugin stderr] ${line}`);
      });
    }

    // `exit` means the process has terminated; stdio may still be open.
    child.on("exit", (code, signal) => {
      handleProcessExit(child, code, signal);
    });

    // ChildProcess `close` follows exit and all stdio closure. Do not release
    // the generation, report a completed stop, or restart before this event.
    child.on("close", (code, signal) => {
      handleProcessClose(child, code, signal);
    });

    // Handle process errors (e.g. spawn failure)
    child.on("error", (err) => {
      if (childProcess !== child) return;
      log.error({ err: err.message }, "worker process error");
      if (emitter.listenerCount("error") > 0) {
        emitter.emit("error", { pluginId, error: err });
      }
      if (status === "starting") {
        setStatus("crashed");
        rejectAllPending(
          new Error(formatWorkerFailureMessage(
            `Worker process failed to start: ${err.message}`,
            stderrExcerpt,
          )),
        );
      }
    });
  }

  function handleProcessExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    emitPublicExit = true,
  ): void {
    if (childProcess !== child || processExited) return;
    processExited = true;
    const wasIntentional = intentionalStop;
    startedAt = null;
    // Keep response readers alive: data written before exit may still be
    // buffered in stdout. New worker requests/notifications are dropped by
    // handleLine while processExited is true.
    if (emitPublicExit) emitter.emit("exit", { pluginId, code, signal });

    if (wasIntentional) return;

    // Unexpected exit — crash recovery
    totalCrashes++;
    const now = Date.now();

    // Reset consecutive crash counter if enough time passed
    if (lastCrashAt !== null && now - lastCrashAt > CRASH_WINDOW_MS) {
      consecutiveCrashes = 0;
    }
    consecutiveCrashes++;
    lastCrashAt = now;

    log.error(
      { code, signal, consecutiveCrashes, totalCrashes },
      "worker process crashed",
    );

    const willRestart = autoRestart && consecutiveCrashes <= MAX_CONSECUTIVE_CRASHES;
    pendingCrash = { code, signal, willRestart };
    setStatus("crashed");
  }

  function handleProcessClose(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (childProcess !== child) return;
    if (!processExited) handleProcessExit(child, code, signal, false);

    // At close, all stdio is drained. Any RPC without a buffered final
    // response is now terminal and may receive worker_exit acknowledgement.
    rejectAllPending(
      new Error(formatWorkerFailureMessage(
        `Worker process exited (code=${code}, signal=${signal})`,
        stderrExcerpt,
      )),
    );

    const closedGeneration = streamOwnerGeneration;
    if (closedGeneration) rememberRetiredStreamGeneration(closedGeneration);
    if (openStreamChannels.size > 0 && options.onStreamNotification && closedGeneration) {
      for (const { channel, companyId } of openStreamChannels.values()) {
        try {
          void Promise.resolve(options.onStreamNotification(
            "streams.close",
            { channel, companyId },
            closedGeneration,
            () => streamOwnerGeneration === closedGeneration || retiredStreamGenerations.has(closedGeneration),
          )).catch(() => undefined);
        } catch {
          // Best-effort cleanup — don't let it interfere with close handling
        }
      }
      openStreamChannels.clear();
    }

    if (readline) {
      readline.close();
      readline = null;
    }
    if (stderrReadline) {
      stderrReadline.close();
      stderrReadline = null;
    }
    childProcess = null;
    streamOwnerGeneration = null;
    processExited = false;
    resolveProcessClose?.();
    resolveProcessClose = null;
    processClosePromise = null;

    if (intentionalStop) {
      pendingCrash = null;
      setStatus("stopped");
      log.info({ code, signal }, "worker process stopped and stdio closed");
      return;
    }

    const crash = pendingCrash;
    pendingCrash = null;
    if (!crash) return;
    emitter.emit("crash", {
      pluginId,
      code: crash.code,
      signal: crash.signal,
      willRestart: crash.willRestart,
    });

    if (crash.willRestart) {
      scheduleRestart();
    } else {
      log.error(
        { consecutiveCrashes, maxCrashes: MAX_CONSECUTIVE_CRASHES },
        "max consecutive crashes reached, not restarting",
      );
    }
  }

  function rejectAllPending(error: Error): void {
    for (const [id, pending] of pendingRequests) {
      if (pending.responseReceived) continue;
      clearTimeout(pending.timer);
      notifyTerminal(pending, "worker_exit");
      pending.resolve(
        createErrorResponse(
          pending.id,
          PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
          error.message,
        ) as JsonRpcResponse,
      );
    }
    for (const [id, late] of lateTerminalAcks) {
      const entry = activeInvocations.get(late.invocationId);
      if (entry?.timer) clearTimeout(entry.timer);
      activeInvocations.delete(late.invocationId);
      void Promise.resolve(late.onTerminal("worker_exit")).catch(() => undefined);
      lateTerminalAcks.delete(id);
    }
    for (const invocation of activeInvocations.values()) {
      if (invocation.timer) clearTimeout(invocation.timer);
    }
    activeInvocations.clear();
  }

  // -----------------------------------------------------------------------
  // Crash recovery with exponential backoff
  // -----------------------------------------------------------------------

  function computeBackoffMs(): number {
    // Exponential backoff: MIN_BACKOFF * MULTIPLIER^(consecutiveCrashes - 1)
    const delay =
      MIN_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveCrashes - 1);
    // Add jitter: ±25%
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(Math.round(delay + jitter), MAX_BACKOFF_MS);
  }

  function scheduleRestart(): void {
    const delay = computeBackoffMs();
    nextRestartAt = Date.now() + delay;

    setStatus("backoff");

    log.info(
      { delayMs: delay, consecutiveCrashes },
      "scheduling restart with backoff",
    );

    backoffTimer = setTimeout(async () => {
      backoffTimer = null;
      nextRestartAt = null;
      if (intentionalStop || status === "stopping" || status === "stopped") {
        return;
      }
      try {
        await startInternal();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          "restart after backoff failed",
        );
      }
    }, delay);
  }

  function cancelPendingRestart(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
      nextRestartAt = null;
    }
  }

  // -----------------------------------------------------------------------
  // Start / Stop
  // -----------------------------------------------------------------------

  function assertManagerAcceptsStart(): void {
    if (!canStart()) {
      throw new Error(`Cannot start worker for plugin "${pluginId}" — manager is shut down or stopping all workers`);
    }
  }

  // Process and stop callbacks can change status while initialization is awaited.
  function currentStatus(): WorkerStatus { return status; }

  async function startInternal(): Promise<void> {
    if (status === "stopping") {
      throw new Error(`Cannot start worker for plugin "${pluginId}" while it is stopping`);
    }

    assertManagerAcceptsStart();

    if (status === "running" || status === "starting") {
      throw new Error(`Worker for plugin "${pluginId}" is already ${status}`);
    }
    if (childProcess) {
      throw new Error(`Cannot start worker for plugin "${pluginId}" before its previous process and stdio close`);
    }

    intentionalStop = false;
    setStatus("starting");
    stderrExcerpt = "";

    const child = spawnProcess();
    childProcess = child;
    processExited = false;
    pendingCrash = null;
    processClosePromise = new Promise<void>((resolve) => { resolveProcessClose = resolve; });
    attachStdioHandlers(child);
    startedAt = Date.now();

    // Send the initialize RPC call
    const initParams: InitializeParams = {
      manifest: options.manifest,
      config: options.config,
      instanceInfo: options.instanceInfo,
      apiVersion: options.apiVersion,
      spsHost: describeSpsHostSupport(options.hostHandlers),
      databaseNamespace: options.databaseNamespace ?? null,
    };

    initializing = true;
    try {
      const result = await callInternal(
        "initialize",
        initParams,
        INITIALIZE_TIMEOUT_MS,
      ) as { ok?: boolean; supportedMethods?: string[] } | undefined;
      if (!result || !result.ok) {
        throw new Error("Worker initialize returned ok=false");
      }
      if (intentionalStop || currentStatus() !== "starting") {
        throw new Error("Worker was stopped during initialize");
      }
      supportedMethods = result.supportedMethods ?? [];
    } catch (err) {
      // Initialize failed — kill the process and propagate
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "worker initialize failed");
      intentionalStop = true;
      cancelPendingRestart();
      if (currentStatus() !== "stopping" && currentStatus() !== "stopped") {
        await killProcess();
        setStatus("crashed");
      }
      throw new Error(`Worker initialize failed for "${pluginId}": ${msg}`);
    } finally {
      initializing = false;
    }

    // Reset crash counter on successful start
    consecutiveCrashes = 0;
    setStatus("running");
    emitter.emit("ready", { pluginId });
    log.info({ pid: child.pid }, "worker process started and initialized");
  }

  async function stopInternal(): Promise<void> {
    cancelPendingRestart();

    if (status === "stopped") {
      return;
    }

    intentionalStop = true;
    setStatus("stopping");

    if (!childProcess) {
      setStatus("stopped");
      return;
    }

    if (processExited) {
      const closed = await waitForClose(2_000);
      if (!closed || childProcess) {
        throw new Error(`Worker for plugin "${pluginId}" exited but did not confirm stdio closure`);
      }
      setStatus("stopped");
      return;
    }

    // Step 1: Send shutdown RPC and wait for the worker to exit gracefully.
    // We race the shutdown call against a timeout. The worker should process
    // the shutdown and exit on its own within the drain period.
    try {
      await Promise.race([
        callInternal("shutdown", {} as Record<string, never>, SHUTDOWN_DRAIN_MS),
        waitForExit(SHUTDOWN_DRAIN_MS),
      ]);
    } catch {
      // Shutdown call failed or timed out — proceed to kill
      log.warn("shutdown RPC failed or timed out, escalating to SIGTERM");
    }

    // Give the process a brief moment to exit after the shutdown response
    if (childProcess) {
      await waitForExit(500);
    }

    // Check if process already exited
    if (!childProcess) {
      setStatus("stopped");
      return;
    }
    if (processExited) {
      const closed = await waitForClose(2_000);
      if (!closed || childProcess) {
        throw new Error(`Worker for plugin "${pluginId}" exited but did not confirm stdio closure`);
      }
      setStatus("stopped");
      return;
    }

    // Step 2: Send SIGTERM and wait
    log.info("worker did not exit after shutdown RPC, sending SIGTERM");
    await killWithSignal("SIGTERM", SIGTERM_GRACE_MS);

    if (!childProcess) {
      setStatus("stopped");
      return;
    }
    if (processExited) {
      const closed = await waitForClose(2_000);
      if (!closed || childProcess) {
        throw new Error(`Worker for plugin "${pluginId}" exited but did not confirm stdio closure`);
      }
      setStatus("stopped");
      return;
    }

    // Step 3: Forcefully kill with SIGKILL
    log.warn("worker did not exit after SIGTERM, sending SIGKILL");
    const closedAfterKill = await killWithSignalAndWaitForClose("SIGKILL", 2_000);

    if (!closedAfterKill && childProcess && !processExited) {
      log.error("worker process still alive after SIGKILL — this should not happen");
      throw new Error(
        `Worker for plugin "${pluginId}" remained alive after SIGKILL`,
      );
    }

    if (!closedAfterKill || childProcess) {
      throw new Error(`Worker for plugin "${pluginId}" exited but did not confirm stdio closure`);
    }

    setStatus("stopped");
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;

    const current = stopInternal().finally(() => {
      if (stopPromise === current) stopPromise = null;
    });
    stopPromise = current;
    return current;
  }

  /**
   * Wait for the child process to exit, up to `timeoutMs`.
   * Resolves immediately if the process is already gone.
   */
  function waitForExit(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = childProcess;
      if (!child || processExited) {
        resolve();
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, timeoutMs);

      child.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Wait for the current exact generation to emit ChildProcess `close`. */
  function waitForClose(timeoutMs: number): Promise<boolean> {
    const child = childProcess;
    const close = processClosePromise;
    if (!child) return Promise.resolve(true);
    if (!close) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void close.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(childProcess !== child);
      });
    });
  }

  /** Send the final signal and spend the existing final-drain budget awaiting close. */
  async function killWithSignalAndWaitForClose(
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<boolean> {
    const child = childProcess;
    if (!child) return true;
    try {
      if (childProcess === child && !processExited) child.kill(signal);
    } catch {
      // The exact child may have exited while the signal was being sent.
    }
    return waitForClose(waitMs);
  }

  function killWithSignal(
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = childProcess;
      if (!child || processExited) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        resolve();
      }, waitMs);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        if (childProcess === child && !processExited) child.kill(signal);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async function killProcess(): Promise<void> {
    intentionalStop = true;
    const child = childProcess;
    if (!child) return;
    try {
      if (childProcess === child && !processExited) child.kill("SIGKILL");
    } catch {
      // Process may already be dead
    }
    // Reuse the existing startup-failure wait budget; an unconfirmed close
    // leaves this exact child retained, so a later start remains blocked.
    if (childProcess === child) await waitForClose(1_000);
  }

  // -----------------------------------------------------------------------
  // RPC call implementation
  // -----------------------------------------------------------------------

  function callInternal<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs?: number,
    authority?: WorkerInvocationAuthority,
    terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
  ): Promise<HostToWorkerMethods[M][1]> {
    const invocationScope = deriveInvocationScope(method, params);
    // Capture the Host's selection before any async check. A caller mutating its
    // original object cannot retarget an already admitted invocation.
    const boundWorkspaceId = authority?.boundWorkspaceId;
    const capturedAuthority = authority && boundWorkspaceId !== undefined
      ? Object.freeze({ ...authority, boundWorkspaceId }) : authority;
    if (capturedAuthority) {
      const authority = capturedAuthority;
      if (!invocationScope || !matchesBoundCall(method, params, authority)
        || (!invocationScope.companyId && !authority.allowHostInvocation)) {
        void Promise.resolve((authority.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
        return Promise.reject(invocationDenied());
      }
      if (authority.signal?.aborted) {
        void Promise.resolve((authority.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
        return Promise.reject(invocationDenied());
      }
      return (async () => {
        try {
          await assertAuthorityCurrent(authority);
        } catch {
          void Promise.resolve((authority.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
          throw invocationDenied();
        }
        if (!matchesBoundCall(method, params, authority)
          || authority.signal?.aborted || !childProcess?.stdin?.writable ||
          (status !== "running" && status !== "starting")) {
          void Promise.resolve((authority.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
          throw invocationDenied();
        }
        return dispatchCall(method, params, timeoutMs, authority, invocationScope, terminalObserver);
      })();
    }
    return dispatchCall(method, params, timeoutMs, undefined, invocationScope, terminalObserver);
  }

  function dispatchCall<M extends HostToWorkerMethodName>(
    method: M,
    params: HostToWorkerMethods[M][0],
    timeoutMs: number | undefined,
    authority: WorkerInvocationAuthority | undefined,
    invocationScope: PluginInvocationScope | null,
    terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
  ): Promise<HostToWorkerMethods[M][1]> {
    const rpcPromise = new Promise<HostToWorkerMethods[M][1]>((resolve, reject) => {
      if (processExited || !childProcess?.stdin?.writable) {
        void Promise.resolve((authority?.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
        reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is not running`,
          ),
        );
        return;
      }
      const id = nextRequestId++;
      const timeout = Math.min(timeoutMs ?? rpcTimeoutMs, MAX_RPC_TIMEOUT_MS);
      const invocation = invocationScope
        ? registerInvocation(invocationScope, undefined, authority)
        : null;

      // Guard against double-settlement. When a process exits all pending
      // requests are rejected via rejectAllPending(), but the timeout timer
      // may still be running. Without this guard the timer's reject fires on
      // an already-settled promise, producing an unhandled rejection.
      let settled = false;

      const settle = <T>(fn: (value: T) => void, value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingRequests.delete(id);
        pending.removeAbortListener?.();
        if (pending.timedOut && pending.onTerminal && invocation?.id && !pending.terminalNotified) {
          const active = activeInvocations.get(invocation.id);
          if (active) active.invalidated = true;
          if (ownerWorkspaceId !== undefined) closeInvocationStreams(invocation.id);
          lateTerminalAcks.set(id, { invocationId: invocation.id, onTerminal: pending.onTerminal });
        } else {
          clearInvocation(invocation);
        }
        fn(value);
      };

      const timer = setTimeout(() => {
        pending.timedOut = true;
        settle(
          reject,
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: `RPC call "${method}" timed out after ${timeout}ms`,
          }),
        );
      }, timeout);

      const pending: PendingRequest = {
        id,
        method,
        resolve: (response: JsonRpcResponse) => {
          if (isJsonRpcSuccessResponse(response)) {
            settle(resolve, response.result as HostToWorkerMethods[M][1]);
          } else if ("error" in response && response.error) {
            settle(reject, new JsonRpcCallError(response.error));
          } else {
            settle(reject, new Error(`Unexpected response format for "${method}"`));
          }
        },
        timer,
        sentAt: Date.now(),
        invocationId: invocation?.id,
        onTerminal: authority?.onTerminal ?? terminalObserver,
      };

      if (authority?.signal) {
        const abort = () => {
          const active = invocation ? activeInvocations.get(invocation.id) : undefined;
          if (active) active.invalidated = true;
          if (invocation && ownerWorkspaceId !== undefined) closeInvocationStreams(invocation.id);
          if (pending.deliveryCancelled) return;
          pending.deliveryCancelled = true;
        };
        pending.removeAbortListener = () => authority.signal?.removeEventListener("abort", abort);
        authority.signal.addEventListener("abort", abort, { once: true });
        if (authority.signal.aborted) {
          const active = invocation ? activeInvocations.get(invocation.id) : undefined;
          if (active) active.invalidated = true;
          if (invocation && ownerWorkspaceId !== undefined) closeInvocationStreams(invocation.id);
          pending.removeAbortListener?.();
          clearTimeout(timer);
          clearInvocation(invocation);
          pendingRequests.delete(id);
          void Promise.resolve((authority.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
          reject(invocationDenied());
          return;
        }
      }

      pendingRequests.set(id, pending);

      try {
        const request = {
          ...createRequest(method, params, id),
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        };
        sendMessage(request);
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        pending.removeAbortListener?.();
        clearInvocation(invocation);
        void Promise.resolve((authority?.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
        reject(
          new Error(
            `Failed to send "${method}" to worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });

    // Some call sites hand these promises across async boundaries before
    // attaching their own handlers. Mark the promise as handled here so a
    // worker-side JSON-RPC error can fail the caller without killing the host
    // process via an unhandled rejection.
    void rpcPromise.catch(() => undefined);

    return rpcPromise;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  const handle: PluginWorkerHandle = {
    get pluginId() {
      return pluginId;
    },

    ...(ownerWorkspaceId !== undefined ? { workspaceId: ownerWorkspaceId } : {}),

    get status() {
      return status;
    },

    get supportedMethods() {
      return supportedMethods;
    },

    async start() {
      await startInternal();
    },

    stop() {
      return stop();
    },

    async restart() {
      assertManagerAcceptsStart();
      await stop();
      await startInternal();
    },

    call<M extends HostToWorkerMethodName>(
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      authority?: WorkerInvocationAuthority,
      terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
    ): Promise<HostToWorkerMethods[M][1]> {
      if (ownerWorkspaceId !== undefined) {
        const allowedHealthCheck = method === "health" && authority === undefined;
        const allowedWorkspaceInvocation = (method === "getData" || method === "performAction")
          && authority?.boundWorkspaceId === ownerWorkspaceId;
        if (!allowedHealthCheck && !allowedWorkspaceInvocation) {
          void Promise.resolve((authority?.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
          return Promise.reject(invocationDenied());
        }
      }
      if (status !== "running" && status !== "starting") {
        void Promise.resolve((authority?.onTerminal ?? terminalObserver)?.("not_dispatched")).catch(() => undefined);
        return Promise.reject(
          new Error(
            `Cannot call "${method}" — worker for "${pluginId}" is ${status}`,
          ),
        );
      }
      return callInternal(method, params, timeoutMs, authority, terminalObserver);
    },

    notify(method: string, params: unknown) {
      if (ownerWorkspaceId !== undefined) return;
      if (status !== "running") return;
      const invocationScope = deriveInvocationScope(method, params);
      const invocation = invocationScope ? registerInvocation(invocationScope, MAX_RPC_TIMEOUT_MS) : null;
      try {
        sendMessage({
          jsonrpc: JSONRPC_VERSION,
          method,
          params,
          ...(invocation ? { paperclipInvocation: invocation } : {}),
        });
      } catch {
        clearInvocation(invocation);
        log.warn({ method }, "failed to send notification to worker");
      }
    },

    on<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.on(event, listener);
    },

    off<K extends WorkerHandleEventName>(
      event: K,
      listener: (payload: WorkerHandleEvents[K]) => void,
    ) {
      emitter.off(event, listener);
    },

    diagnostics(): WorkerDiagnostics {
      return {
        pluginId,
        ...(ownerWorkspaceId !== undefined ? { workspaceId: ownerWorkspaceId } : {}),
        status,
        pid: childProcess?.pid ?? null,
        uptime:
          startedAt !== null && status === "running"
            ? Date.now() - startedAt
            : null,
        consecutiveCrashes,
        totalCrashes,
        pendingRequests: pendingRequests.size,
        lastCrashAt,
        nextRestartAt,
      };
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Implementation: createPluginWorkerManager
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginWorkerManager.
 */
export interface PluginWorkerManagerOptions {
  /**
   * Optional callback invoked when a worker emits a lifecycle event
   * (crash, restart). Used by the server to publish global live events.
   */
  onWorkerEvent?: (event: {
    type: "plugin.worker.crashed" | "plugin.worker.restarted";
    pluginId: string;
    workspaceId?: string;
    code?: number | null;
    signal?: string | null;
    willRestart?: boolean;
  }) => void;
}

/**
 * Create a new PluginWorkerManager.
 *
 * The manager holds all plugin worker handles and provides a unified API for
 * starting, stopping, and communicating with plugin workers.
 *
 * @example
 * ```ts
 * const manager = createPluginWorkerManager();
 *
 * const handle = await manager.startWorker("acme.linear", {
 *   entrypointPath: "/path/to/worker.cjs",
 *   manifest,
 *   config: resolvedConfig,
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 *   apiVersion: 1,
 *   hostHandlers: { "config.get": async () => resolvedConfig, ... },
 * });
 *
 * // Send RPC call to the worker
 * const health = await manager.call("acme.linear", "health", {});
 *
 * // Shutdown all workers on server exit
 * await manager.stopAll();
 * ```
 */
export function createPluginWorkerManager(
  managerOptions?: PluginWorkerManagerOptions,
): PluginWorkerManager {
  const log = logger.child({ service: "plugin-worker-manager" });
  const workers = new Map<string, PluginWorkerHandle>();
  /** Per-owner startup locks to prevent concurrent spawn races. */
  const startupLocks = new Map<string, Promise<PluginWorkerHandle>>();
  const stoppingPlugins = new Set<string>();
  const stoppingWorkspaceScopes = new Set<string>();
  const stoppingWorkspacePlugins = new Set<string>();
  const workspaceStopPromises = new Map<string, Promise<void>>();
  const pluginStopPromises = new Map<string, Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  let stoppingAll = false;
  let stopAllPromise: Promise<void> | null = null;

  const hostOwner = (pluginId: string): WorkerOwner => ({ workspaceId: null, pluginId });
  const workspaceOwner = (workspaceId: string, pluginId: string): WorkerOwner => ({ workspaceId, pluginId });
  const ownerOf = (handle: PluginWorkerHandle): WorkerOwner => ({
    workspaceId: handle.workspaceId ?? null,
    pluginId: handle.pluginId,
  });
  const keyOf = (owner: WorkerOwner): string => workerOwnerKey(owner);
  const canStartOwner = (owner: WorkerOwner): boolean => !closed && !stoppingAll
    && !stoppingPlugins.has(owner.pluginId)
    && (owner.workspaceId === null || (!stoppingWorkspaceScopes.has(owner.workspaceId)
      && !stoppingWorkspacePlugins.has(keyOf(owner))));

  function rejectTerminal(observer?: WorkerInvocationAuthority["onTerminal"]): void {
    void Promise.resolve(observer?.("not_dispatched")).catch(() => undefined);
  }

  function startOwnedWorker(owner: WorkerOwner, options: WorkerStartOptions): Promise<PluginWorkerHandle> {
    if (Object.prototype.hasOwnProperty.call(options, "workspaceId")) {
      throw new TypeError("Workspace ownership must be selected with startWorkspaceWorker");
    }
    if (closed) throw new Error("Plugin worker manager is shut down");
    if (stoppingAll) throw new Error("Plugin worker manager is stopping all workers");
    if (stoppingPlugins.has(owner.pluginId)) throw new Error(`Plugin worker manager is stopping plugin "${owner.pluginId}"`);
    if (owner.workspaceId !== null && stoppingWorkspaceScopes.has(owner.workspaceId)) {
      throw new Error(`Plugin worker manager is stopping Workspace "${owner.workspaceId}"`);
    }
    if (owner.workspaceId !== null && stoppingWorkspacePlugins.has(keyOf(owner))) {
      throw new Error(`Plugin worker manager is stopping Workspace worker "${owner.pluginId}"`);
    }

    const key = keyOf(owner);
    const inFlight = startupLocks.get(key);
    if (inFlight) return inFlight;

    const existing = workers.get(key);
    if (existing && existing.status !== "stopped") {
      throw new Error(`Worker already registered for plugin "${owner.pluginId}" (status: ${existing.status})`);
    }

    const startOptions = owner.workspaceId === null ? options : { ...options, autoRestart: false };
    const handle = createPluginWorkerHandleInternal(
      owner.pluginId,
      startOptions,
      () => canStartOwner(owner) && workers.get(key) === handle,
      owner.workspaceId ?? undefined,
    );
    workers.set(key, handle);

    if (managerOptions?.onWorkerEvent) {
      const notify = managerOptions.onWorkerEvent;
      const workspaceEvent = owner.workspaceId !== null ? { workspaceId: owner.workspaceId } : {};
      handle.on("crash", (payload) => notify({
        type: "plugin.worker.crashed",
        pluginId: payload.pluginId,
        ...workspaceEvent,
        code: payload.code,
        signal: payload.signal,
        willRestart: payload.willRestart,
      }));
      handle.on("ready", (payload) => {
        if (handle.diagnostics().totalCrashes > 0) {
          notify({ type: "plugin.worker.restarted", pluginId: payload.pluginId, ...workspaceEvent });
        }
      });
    }

    log.info({ pluginId: owner.pluginId, ...(owner.workspaceId ? { workspaceId: owner.workspaceId } : {}) }, "starting plugin worker");
    let startPromise!: Promise<PluginWorkerHandle>;
    startPromise = handle.start().then(() => handle).finally(() => {
      if (startupLocks.get(key) === startPromise) startupLocks.delete(key);
    });
    startupLocks.set(key, startPromise);
    return startPromise;
  }

  async function stopMatchingWorkers(predicate: (owner: WorkerOwner) => boolean): Promise<void> {
    // The caller fences matching starts before entering here. Every admitted
    // start already has a registered handle, so snapshot and stop those exact
    // children immediately, then join their initialize promises concurrently.
    const entries = Array.from(workers.entries()).filter(([, handle]) => predicate(ownerOf(handle)));
    const selectedKeys = new Set(entries.map(([key]) => key));
    const starts = Array.from(startupLocks.entries())
      .filter(([key]) => selectedKeys.has(key))
      .map(([, promise]) => promise);
    const stopResultsPromise = Promise.allSettled(entries.map(async ([key, handle]) => {
      await handle.stop();
      const diag = handle.diagnostics();
      if (diag.status !== "stopped" || diag.pid !== null) {
        throw new Error(`Worker for plugin "${handle.pluginId}" did not confirm process and stdio close`);
      }
      if (workers.get(key) === handle) workers.delete(key);
    }));
    await Promise.allSettled(starts);
    const results = await stopResultsPromise;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), "One or more plugin workers failed to stop");
    }
  }

  return {
    async startWorker(pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle> {
      return startOwnedWorker(hostOwner(pluginId), options);
    },

    async startWorkspaceWorker(workspaceId: string, pluginId: string, options: WorkerStartOptions): Promise<PluginWorkerHandle> {
      assertWorkspaceId(workspaceId);
      return startOwnedWorker(workspaceOwner(workspaceId, pluginId), options);
    },

    stopWorker(pluginId: string): Promise<void> {
      const existingStop = pluginStopPromises.get(pluginId);
      if (existingStop) return existingStop;
      stoppingPlugins.add(pluginId);
      const stopPromise = stopMatchingWorkers((owner) => owner.pluginId === pluginId).finally(() => {
        stoppingPlugins.delete(pluginId);
        if (pluginStopPromises.get(pluginId) === stopPromise) pluginStopPromises.delete(pluginId);
      });
      pluginStopPromises.set(pluginId, stopPromise);
      return stopPromise;
    },

    async stopWorkspaceWorkers(workspaceId: string, pluginId?: string): Promise<void> {
      assertWorkspaceId(workspaceId);
      const selectorKey = JSON.stringify([workspaceId, pluginId ?? null]);
      const existingStop = workspaceStopPromises.get(selectorKey);
      if (existingStop) return existingStop;
      if (pluginId === undefined) stoppingWorkspaceScopes.add(workspaceId);
      else stoppingWorkspacePlugins.add(keyOf(workspaceOwner(workspaceId, pluginId)));
      const stopPromise = stopMatchingWorkers((owner) => owner.workspaceId === workspaceId
        && (pluginId === undefined || owner.pluginId === pluginId)).finally(() => {
        if (pluginId === undefined) stoppingWorkspaceScopes.delete(workspaceId);
        else stoppingWorkspacePlugins.delete(keyOf(workspaceOwner(workspaceId, pluginId)));
        if (workspaceStopPromises.get(selectorKey) === stopPromise) workspaceStopPromises.delete(selectorKey);
      });
      workspaceStopPromises.set(selectorKey, stopPromise);
      return stopPromise;
    },

    getWorker(pluginId: string): PluginWorkerHandle | undefined {
      return workers.get(keyOf(hostOwner(pluginId)));
    },

    getWorkspaceWorker(workspaceId: string, pluginId: string): PluginWorkerHandle | undefined {
      assertWorkspaceId(workspaceId);
      return workers.get(keyOf(workspaceOwner(workspaceId, pluginId)));
    },

    isRunning(pluginId: string): boolean {
      const handle = workers.get(keyOf(hostOwner(pluginId)));
      return handle?.status === "running";
    },

    stopAll(): Promise<void> {
      if (stopAllPromise) return stopAllPromise;
      stoppingAll = true;
      log.info({ count: workers.size }, "stopping all plugin workers");
      const current = (async () => {
        await stopMatchingWorkers(() => true);
      })().finally(() => {
        stoppingAll = false;
        if (stopAllPromise === current) stopAllPromise = null;
      });
      stopAllPromise = current;
      return current;
    },

    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;

      closed = true;
      const current = (async () => {
        // Terminal shutdown keeps its legacy startup-join behavior: callers
        // awaiting start() receive its normal completion/failure before the
        // shutdown promise settles, then every registered child is closed.
        await Promise.allSettled(Array.from(startupLocks.values()));
        const existingWorkers = Array.from(workers.entries());
        const results = await Promise.allSettled(existingWorkers.map(async ([, worker]) => {
          await worker.stop();
          const diagnostics = worker.diagnostics();
          if (diagnostics.status !== "stopped" || diagnostics.pid !== null) {
            throw new Error(
              `Worker for plugin "${worker.pluginId}" did not confirm process and stdio close ` +
              `(status: ${diagnostics.status}, pid: ${diagnostics.pid ?? "none"})`,
            );
          }
        }));

        const errors: Error[] = [];
        results.forEach((result, index) => {
          if (result.status === "fulfilled") return;
          const [, handle] = existingWorkers[index]!;
          const error = result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
          log.error(
            { pluginId: handle.pluginId, err: error.message },
            "error stopping worker during terminal shutdown",
          );
          errors.push(error);
        });

        if (errors.length > 0) {
          throw new AggregateError(errors, "One or more plugin workers failed to stop");
        }
      })();
      shutdownPromise = current;
      return current;
    },

    diagnostics(): WorkerDiagnostics[] {
      return Array.from(workers.values()).map((h) => h.diagnostics());
    },

    call<M extends HostToWorkerMethodName>(
      pluginId: string,
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      authority?: WorkerInvocationAuthority,
      terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
    ): Promise<HostToWorkerMethods[M][1]> {
      const handle = workers.get(keyOf(hostOwner(pluginId)));
      if (!handle) {
        void Promise.resolve(terminalObserver?.("not_dispatched")).catch(() => undefined);
        return Promise.reject(
          new Error(`No worker registered for plugin "${pluginId}"`),
        );
      }
      return handle.call(method, params, timeoutMs, authority, terminalObserver);
    },

    callWorkspaceWorker<M extends HostToWorkerMethodName>(
      workspaceId: string,
      pluginId: string,
      method: M,
      params: HostToWorkerMethods[M][0],
      timeoutMs?: number,
      authority?: WorkerInvocationAuthority,
      terminalObserver?: (reason: "response" | "worker_exit" | "not_dispatched") => void,
    ): Promise<HostToWorkerMethods[M][1]> {
      assertWorkspaceId(workspaceId);
      if (!authority || authority.boundWorkspaceId !== workspaceId
        || (method !== "getData" && method !== "performAction")) {
        rejectTerminal(authority?.onTerminal ?? terminalObserver);
        return Promise.reject(new JsonRpcCallError({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
          message: "Workspace worker calls require matching Host authority",
        }));
      }
      const handle = workers.get(keyOf(workspaceOwner(workspaceId, pluginId)));
      if (!handle) {
        rejectTerminal(authority.onTerminal ?? terminalObserver);
        return Promise.reject(new Error(`No Workspace worker registered for plugin "${pluginId}"`));
      }
      return handle.call(method, params, timeoutMs, authority, terminalObserver);
    },
  };
}
