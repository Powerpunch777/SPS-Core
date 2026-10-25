import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { spsModelConnections, spsModelGrants, spsModelRuns, type Db } from "../compat/paperclip/db.js";
import type { PluginSpsModelRun, PluginSpsModelSubmitInput } from "../compat/paperclip/plugin-sdk.js";
import { spsModelConnectionService, requireSpsModelId } from "./sps-model-connections.js";
import { createSpsModelCredentialResolver } from "./sps-model-bound-transport.js";
import { createSpsModelTextTransport, SpsModelTransportError } from "./sps-model-transport.js";
import { parseSpsModelTextResponse, type SpsModelTextResponse } from "./sps-model-response.js";
import { assertSpsPluginAvailable } from "./sps-plugin-availability.js";
import { buildSpsUsageEvidence } from "./sps-execution-usage.js";

type Run = typeof spsModelRuns.$inferSelect;
type Connection = typeof spsModelConnections.$inferSelect;
type Task = { run: Run; ownerId: string; controller: AbortController; done: boolean; settled: boolean; checking: boolean; permissionLost: boolean; leaseLost: boolean; work?: Promise<void> };
// This protects brokers in this process sharing the same Db object; it is not a cross-process liveness signal.
const locallyTrackedTasks = new WeakMap<Db, Map<string, Task>>();
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const safeErrors = new Set(["invalid_configuration", "invalid_request", "busy", "cancelled", "timed_out", "network_error", "http_error", "invalid_response",
  "response_too_large", "credential_echo", "credential_unavailable", "dispatch_denied", "permission_revoked", "process_lost", "lease_lost", "execution_failed",
  "auth_required", "provider_limit", "provider_error", "host_restored"]);
const leaseExpiry = sql<Date>`now() + interval '30 seconds'`;
const liveLease = () => and(eq(spsModelRuns.resourcePending, true), gt(spsModelRuns.leaseExpiresAt, sql`now()`));

function readInput(value: PluginSpsModelSubmitInput) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["companyId", "connectionId", "requestKey", "input"].includes(key))
    || typeof value.requestKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestKey)
    || typeof value.input !== "string" || value.input.length > 65_536 || !value.input.trim() || Buffer.byteLength(value.input, "utf8") > 65_536) {
    throw new Error("Invalid model submission");
  }
  return { companyId: requireSpsModelId(value.companyId), connectionId: requireSpsModelId(value.connectionId), requestKey: value.requestKey, input: value.input };
}
function storedResult(value: unknown): SpsModelTextResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || record.text.length > 4_194_304 || record.refusal !== null && typeof record.refusal !== "string"
    || typeof record.refusal === "string" && record.refusal.length > 4_194_304) return null;
  const usage = record.usage as SpsModelTextResponse["usage"];
  try {
    return parseSpsModelTextResponse({ status: record.status, output: [{ type: "message", role: "assistant", content: [
      { type: "output_text", text: record.text }, ...(record.refusal === null ? [] : [{ type: "refusal", refusal: record.refusal }]),
    ] }], usage: usage === null ? null : { input_tokens: usage?.inputTokens, output_tokens: usage?.outputTokens, total_tokens: usage?.totalTokens } });
  } catch { return null; }
}
function project(run: Run, result: SpsModelTextResponse | null = null, resultState: PluginSpsModelRun["resultState"] = "not_ready"): PluginSpsModelRun {
  return { id: run.id, companyId: run.companyId, connectionId: run.connectionId,
    status: ["queued", "running", ...terminal].includes(run.status) ? run.status as PluginSpsModelRun["status"] : "interrupted",
    externalEffects: run.externalEffects === "not_dispatched" ? "not_dispatched" : "unknown",
    errorCode: run.errorCode && safeErrors.has(run.errorCode) ? run.errorCode : null,
    cancellationRequested: run.cancellationRequestedAt !== null, cleanupPending: run.resourcePending,
    resultState, result, createdAt: run.createdAt.toISOString(), startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null };
}

/** One broker per Host DB. No Agent/Task/Node identity or automatic request retry is involved. */
export function createSpsModelBroker(db: Db, dependencies: { fetch?: typeof globalThis.fetch } = {}) {
  const ownerId = randomUUID(), authority = spsModelConnectionService(db);
  const transports = new Map<string, { fingerprint: string; transport: ReturnType<typeof createSpsModelTextTransport> }>();
  const tasks = new Map<string, Task>();
  const tracked = locallyTrackedTasks.get(db) ?? new Map<string, Task>();
  locallyTrackedTasks.set(db, tracked);
  let closed = false, recovering = false;

  async function preserveLeaseLostTask(task: Task) {
    const settled = task.settled;
    await db.update(spsModelRuns).set({
      status: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'interrupted' else ${spsModelRuns.status} end`,
      errorCode: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'lease_lost' else ${spsModelRuns.errorCode} end`,
      finishedAt: sql`coalesce(${spsModelRuns.finishedAt}, now())`,
      resourcePending: !settled,
      leaseOwnerId: settled ? null : task.ownerId,
      leaseExpiresAt: settled ? null : leaseExpiry,
      updatedAt: new Date(),
    }).where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, task.ownerId), eq(spsModelRuns.resourcePending, true)));
  }

  async function recoverExpired() {
    const expired = await db.select({ id: spsModelRuns.id, leaseOwnerId: spsModelRuns.leaseOwnerId }).from(spsModelRuns)
      .where(and(eq(spsModelRuns.resourcePending, true), or(isNull(spsModelRuns.leaseExpiresAt), lte(spsModelRuns.leaseExpiresAt, sql`now()`))));
    for (const row of expired) {
      const task = tracked.get(row.id);
      if (task && task.ownerId === row.leaseOwnerId && (!task.done || !task.settled)) {
        task.leaseLost = true;
        task.controller.abort();
        await preserveLeaseLostTask(task);
        continue;
      }
      await db.update(spsModelRuns).set({
        status: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'interrupted' else ${spsModelRuns.status} end`,
        errorCode: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'process_lost' else ${spsModelRuns.errorCode} end`,
        // A lost running owner may have dispatched; never infer no external effect from process loss.
        externalEffects: sql`case when ${spsModelRuns.status} = 'running' then 'unknown' else ${spsModelRuns.externalEffects} end`,
        finishedAt: sql`coalesce(${spsModelRuns.finishedAt}, now())`, resourcePending: false, leaseOwnerId: null, leaseExpiresAt: null, updatedAt: new Date(),
      }).where(and(eq(spsModelRuns.id, row.id), eq(spsModelRuns.resourcePending, true),
        or(isNull(spsModelRuns.leaseExpiresAt), lte(spsModelRuns.leaseExpiresAt, sql`now()`))));
    }
  }
  async function ownRun(companyId: string, pluginId: string, runId: string) {
    const [row] = await db.select({ run: spsModelRuns }).from(spsModelRuns)
      .innerJoin(spsModelConnections, and(eq(spsModelConnections.id, spsModelRuns.connectionId), eq(spsModelConnections.companyId, companyId)))
      .where(and(eq(spsModelRuns.id, runId), eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.pluginId, pluginId)));
    return row?.run ?? null;
  }
  async function targetFor(run: Run, capability = "sps.models.submit") {
    if (!run.grantId) throw new Error("Model connection is unavailable");
    return authority.authorized({ companyId: run.companyId, pluginId: run.pluginId, connectionId: run.connectionId,
      grantId: run.grantId, grantRevision: run.grantRevision, ...(run.credentialVersion === null ? {} : { credentialVersion: run.credentialVersion }) }, capability);
  }
  async function publicRun(run: Run): Promise<PluginSpsModelRun> {
    if (run.status !== "succeeded") return project(run);
    try {
      if (run.credentialVersion === null) throw new Error("Missing credential version");
      await targetFor(run, "sps.models.read");
      const result = storedResult(run.resultJson);
      return result ? project(run, result, "available") : project(run, null, "withheld");
    } catch { return project(run, null, "withheld"); }
  }
  function transportFor(connection: Connection) {
    const fingerprint = JSON.stringify([connection.protocol, connection.endpoint, connection.model, connection.allowLoopbackHttp, connection.timeoutMs,
      connection.maxOutputTokens, connection.maxRequestBytes, connection.maxResponseBytes, connection.maxConcurrentRequests]);
    let entry = transports.get(connection.id);
    if (entry && entry.fingerprint !== fingerprint) throw new Error("Model connection configuration changed");
    if (!entry) {
      entry = { fingerprint, transport: createSpsModelTextTransport(connection, dependencies) };
      transports.set(connection.id, entry);
    }
    return entry.transport;
  }
  async function tick(task: Task) {
    if (task.checking) return;
    task.checking = true;
    try {
      if (task.done && task.settled) {
        await db.update(spsModelRuns).set({ resourcePending: false, leaseOwnerId: null, leaseExpiresAt: null, updatedAt: new Date(),
          status: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'interrupted' else ${spsModelRuns.status} end`,
          errorCode: sql`case when ${spsModelRuns.status} in ('queued', 'running') then 'lease_lost' else ${spsModelRuns.errorCode} end`,
          finishedAt: sql`coalesce(${spsModelRuns.finishedAt}, now())` })
          .where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, ownerId)));
        tasks.delete(task.run.id);
        if (tracked.get(task.run.id) === task) tracked.delete(task.run.id);
        return;
      }
      if (task.leaseLost) {
        // Keep a cleanup-only reservation until the transport and its cleanup settle.
        await preserveLeaseLostTask(task);
        return;
      }
      const renewed = await db.update(spsModelRuns).set({ leaseExpiresAt: leaseExpiry, updatedAt: new Date() })
        .where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, ownerId), liveLease())).returning({ cancellationRequestedAt: spsModelRuns.cancellationRequestedAt });
      if (!renewed[0]) {
        task.leaseLost = true;
        task.controller.abort();
        await preserveLeaseLostTask(task);
        return;
      }
      if (task.leaseLost) {
        await preserveLeaseLostTask(task);
        return;
      }
      if (renewed[0].cancellationRequestedAt) task.controller.abort();
      try { await targetFor(task.run); } catch { task.permissionLost = true; task.controller.abort(); }
    } catch {
      task.leaseLost = true;
      task.controller.abort();
      try { await preserveLeaseLostTask(task); } catch { /* A later tick or recovery retries the cleanup reservation. */ }
    }
    finally { task.checking = false; }
  }
  const timer = setInterval(() => {
    for (const task of tasks.values()) void tick(task);
    if (!recovering) {
      recovering = true;
      void recoverExpired().catch(() => undefined).finally(() => { recovering = false; });
    }
  }, 5_000);
  timer.unref();

  async function execute(task: Task, input: string) {
    let response: SpsModelTextResponse | null = null, errorCode: string | null = null;
    let observedUsage: SpsModelTextResponse["usage"] = null;
    let status: Run["status"] = "failed", effects: Run["externalEffects"] = "not_dispatched";
    let started: ReturnType<ReturnType<typeof createSpsModelTextTransport>["start"]> | null = null;
    try {
      const target = await targetFor(task.run);
      if (task.leaseLost || task.controller.signal.aborted) throw new SpsModelTransportError("cancelled", "not_dispatched");
      const claimed = await db.update(spsModelRuns).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, ownerId), liveLease(), eq(spsModelRuns.status, "queued"), isNull(spsModelRuns.cancellationRequestedAt))).returning();
      if (!claimed[0]) throw new SpsModelTransportError("cancelled", "not_dispatched");
      task.run = claimed[0];
      const credential = createSpsModelCredentialResolver(db, { companyId: task.run.companyId, pluginId: task.run.pluginId, connectionId: task.run.connectionId,
        bindingId: target.grant.bindingId!, expectedSecretId: target.connection.secretId!, expectedVersionSelector: target.connection.versionSelector,
        onResolvedVersion: version => { task.run.credentialVersion = version; } });
      started = transportFor(target.connection).start({ input, credential, signal: task.controller.signal, beforeDispatch: async signal => {
        if (task.leaseLost || signal.aborted) throw new Error("Model dispatch is unavailable");
        await targetFor(task.run);
        if (task.leaseLost || signal.aborted || task.run.credentialVersion === null) throw new Error("Model dispatch is unavailable");
        const rows = await db.update(spsModelRuns).set({ externalEffects: "unknown", credentialVersion: task.run.credentialVersion, updatedAt: new Date() })
          .where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, ownerId), liveLease(), eq(spsModelRuns.status, "running"), isNull(spsModelRuns.cancellationRequestedAt))).returning({ id: spsModelRuns.id });
        if (!rows[0]) throw new Error("Model dispatch is unavailable");
        effects = "unknown";
      } });
      void started.settled.then(() => { task.settled = true; void tick(task); });
      response = await started.result;
      observedUsage = response.usage;
      await targetFor(task.run);
      if (task.leaseLost || task.controller.signal.aborted) throw new SpsModelTransportError("cancelled", effects === "unknown" ? "unknown" : "not_dispatched");
      status = "succeeded";
    } catch (error) {
      response = null;
      if (task.leaseLost) errorCode = "lease_lost";
      else if (task.permissionLost) errorCode = "permission_revoked";
      else if (error instanceof SpsModelTransportError) {
        errorCode = error.code === "http_error" && (error.httpStatus === 401 || error.httpStatus === 403) ? "auth_required"
          : error.code === "http_error" && error.httpStatus === 429 ? "provider_limit"
            : error.code === "http_error" && error.httpStatus !== null && error.httpStatus >= 500 ? "provider_error" : error.code;
        if (error.externalEffects === "unknown") effects = "unknown";
      } else {
        try { await targetFor(task.run); errorCode = "execution_failed"; } catch { errorCode = "permission_revoked"; }
      }
      status = errorCode === "cancelled" ? "cancelled" : errorCode === "lease_lost" ? "interrupted" : "failed";
    } finally {
      if (!started) task.settled = true;
      const usageJson = observedUsage ? { spsUsageEvidence: buildSpsUsageEvidence({ usage: observedUsage, usageBasis: "per_run", usageReportedFields: ["inputTokens", "outputTokens"], billingType: "unknown" }) } : null;
      if (!task.leaseLost) {
        try {
          const finished = await db.update(spsModelRuns).set({ status, externalEffects: effects, errorCode,
            resultJson: response ? { ...response } : null, usageJson, finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, task.ownerId), liveLease(), inArray(spsModelRuns.status, ["queued", "running"]),
              status === "succeeded" ? isNull(spsModelRuns.cancellationRequestedAt) : undefined)).returning();
          // A concurrent persisted cancel must never be overwritten by a successful result.
          if (!finished[0]) await db.update(spsModelRuns).set({ status: "cancelled", errorCode: "cancelled", externalEffects: effects, resultJson: null, usageJson,
            finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(spsModelRuns.id, task.run.id), eq(spsModelRuns.leaseOwnerId, task.ownerId), liveLease(),
              inArray(spsModelRuns.status, ["queued", "running"]), sql`${spsModelRuns.cancellationRequestedAt} is not null`));
        } catch { task.leaseLost = true; task.controller.abort(); }
      }
      task.done = true;
      await tick(task);
    }
  }

  return {
    recoverExpired,
    async list(companyId: string, pluginId: string) { await recoverExpired(); return authority.listForPlugin(companyId, pluginId); },
    async submit(pluginIdInput: string, raw: PluginSpsModelSubmitInput): Promise<PluginSpsModelRun> {
      if (closed) throw new Error("Model broker is stopping");
      const pluginId = requireSpsModelId(pluginIdInput), input = readInput(raw);
      await recoverExpired();
      const target = await authority.authorized({ ...input, pluginId });
      const inputHash = createHash("sha256").update(JSON.stringify({ connectionId: input.connectionId, input: input.input })).digest("hex");
      const saved = await db.transaction(async tx => {
        const [connection] = await tx.select({ id: spsModelConnections.id }).from(spsModelConnections)
          .where(and(eq(spsModelConnections.id, input.connectionId), eq(spsModelConnections.companyId, input.companyId), eq(spsModelConnections.status, "active"))).for("update");
        if (!connection) throw new Error("Model connection is unavailable");
        const [existing] = await tx.select().from(spsModelRuns).where(and(eq(spsModelRuns.companyId, input.companyId), eq(spsModelRuns.pluginId, pluginId), eq(spsModelRuns.requestKey, input.requestKey)));
        if (existing) {
          if (existing.inputHash !== inputHash || existing.connectionId !== input.connectionId) throw new Error("Model request key was already used for different input");
          return { run: existing, inserted: false };
        }
        const [active] = await tx.select({ value: count() }).from(spsModelRuns).where(and(eq(spsModelRuns.connectionId, input.connectionId), liveLease()));
        if ((active?.value ?? 0) >= target.connection.maxConcurrentRequests) throw new Error("Model connection is busy");
        const [grant] = await tx.select({ id: spsModelGrants.id }).from(spsModelGrants).where(and(eq(spsModelGrants.id, target.grant.id),
          eq(spsModelGrants.companyId, input.companyId), eq(spsModelGrants.pluginId, pluginId), eq(spsModelGrants.connectionId, input.connectionId),
          eq(spsModelGrants.revision, target.grant.revision), eq(spsModelGrants.status, "active"), isNull(spsModelGrants.revokedAt)));
        if (!grant) throw new Error("Model connection is unavailable");
        const [created] = await tx.insert(spsModelRuns).values({ companyId: input.companyId, pluginId, pluginKey: target.pluginKey, connectionId: input.connectionId,
          grantId: target.grant.id, grantRevision: target.grant.revision, requestKey: input.requestKey, inputHash, leaseOwnerId: ownerId, leaseExpiresAt: leaseExpiry })
          .onConflictDoNothing().returning();
        if (created) return { run: created, inserted: true };
        const [duplicate] = await tx.select().from(spsModelRuns).where(and(eq(spsModelRuns.companyId, input.companyId), eq(spsModelRuns.pluginId, pluginId), eq(spsModelRuns.requestKey, input.requestKey)));
        if (!duplicate || duplicate.inputHash !== inputHash || duplicate.connectionId !== input.connectionId) throw new Error("Model request key was already used for different input");
        return { run: duplicate, inserted: false };
      });
      if (saved.inserted) {
        const task: Task = { run: saved.run, ownerId, controller: new AbortController(), done: false, settled: false, checking: false, permissionLost: false, leaseLost: false };
        tasks.set(task.run.id, task);
        tracked.set(task.run.id, task);
        task.work = execute(task, input.input).catch(() => { task.leaseLost = true; task.controller.abort(); });
      }
      return publicRun(saved.run);
    },
    async get(companyIdInput: string, pluginIdInput: string, runIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput), pluginId = requireSpsModelId(pluginIdInput), runId = requireSpsModelId(runIdInput);
      await assertSpsPluginAvailable(db, { companyId, pluginId }, "sps.models.read"); await recoverExpired();
      const run = await ownRun(companyId, pluginId, runId);
      return run ? publicRun(run) : null;
    },
    async cancel(companyIdInput: string, pluginIdInput: string, runIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput), pluginId = requireSpsModelId(pluginIdInput), runId = requireSpsModelId(runIdInput);
      await assertSpsPluginAvailable(db, { companyId, pluginId }, "sps.models.cancel"); await recoverExpired();
      const run = await ownRun(companyId, pluginId, runId); if (!run) return null;
      if (!terminal.has(run.status)) await db.update(spsModelRuns).set({ cancellationRequestedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(spsModelRuns.id, run.id), eq(spsModelRuns.companyId, companyId), eq(spsModelRuns.pluginId, pluginId), inArray(spsModelRuns.status, ["queued", "running"])));
      tasks.get(run.id)?.controller.abort();
      return publicRun((await ownRun(companyId, pluginId, runId))!);
    },
    async shutdown() {
      closed = true; clearInterval(timer);
      for (const task of tasks.values()) task.controller.abort();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...tasks.values()].map(task => task.work)), new Promise<void>(resolve => { closeTimer = setTimeout(resolve, 5_000); })]);
      } finally { clearTimeout(closeTimer); }
    },
  };
}

const brokers = new WeakMap<Db, ReturnType<typeof createSpsModelBroker>>();
export function getSpsModelBroker(db: Db) {
  let broker = brokers.get(db);
  if (!broker) { broker = createSpsModelBroker(db); brokers.set(db, broker); }
  return broker;
}
export async function shutdownSpsModelBroker(db: Db) { await brokers.get(db)?.shutdown(); }
