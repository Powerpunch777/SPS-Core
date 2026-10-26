import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecretBindings, companySecrets, companySecretVersions, createDb, pluginCompanySettings, plugins, secretAccessEvents, spsModelConnections, spsModelGrants, spsModelRuns } from "@paperclipai/db";
import { createSpsModelBroker } from "../services/sps-model-broker.js";
import { spsModelConnectionService } from "../services/sps-model-connections.js";
import { secretService } from "../services/secrets.js";
import { spsExecutionHistoryService } from "../services/sps-execution-history.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const credential = "fake-model-broker-key-for-isolated-tests-only";
const payload = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Local mock answer" }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
describeDb("durable model request broker", () => {
  let db: ReturnType<typeof createDb>, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  const brokers: ReturnType<typeof createSpsModelBroker>[] = [], servers: Server[] = [];
  beforeAll(async () => { process.env.PAPERCLIP_SECRETS_MASTER_KEY = "2".repeat(64); temporary = await startEmbeddedPostgresTestDatabase("sps-model-broker-"); db = createDb(temporary.connectionString); }, 30_000);
  afterEach(async () => {
    for (const broker of brokers.splice(0)) await broker.shutdown();
    for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await db.delete(spsModelRuns); await db.delete(spsModelGrants); await db.delete(spsModelConnections); await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings); await db.delete(companySecretVersions); await db.delete(companySecrets); await db.delete(pluginCompanySettings); await db.delete(plugins); await db.delete(companies);
  });
  afterAll(async () => { await temporary?.cleanup(); if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey; });
  async function seed(fetch?: typeof globalThis.fetch, endpoint = "https://mock-provider.example/v1/responses") {
    const companyId = randomUUID(), pluginId = randomUUID(), pluginKey = `sps.model-test-${pluginId}`;
    await db.insert(companies).values({ id: companyId, name: "Model test", issuePrefix: `MB${companyId.slice(0, 7).toUpperCase()}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "1.0.0", status: "ready", manifestJson: {
      id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Model test", description: "Fixture", author: "SPS", categories: ["automation"],
      capabilities: ["sps.models.read", "sps.models.submit", "sps.models.cancel"], entrypoints: { worker: "./worker.js" },
    } });
    const secrets = secretService(db), secret = await secrets.create(companyId, { name: "fixture-key", provider: "local_encrypted", value: credential });
    const connections = spsModelConnectionService(db);
    const connection = await connections.create(companyId, { displayName: "Test model", secretId: secret.id, transport: {
      endpoint, model: "mock-model", timeoutMs: 1_000, maxConcurrentRequests: 1, allowLoopbackHttp: endpoint.startsWith("http://127.0.0.1:"),
    } }, "test-host");
    const grant = await connections.grant(companyId, connection.id, pluginId, "test-host");
    const transport = fetch ?? vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const broker = createSpsModelBroker(db, { fetch: transport }); brokers.push(broker);
    return { companyId, pluginId, pluginKey, secrets, secret, connections, connection, grant, broker, fetch: transport,
      input: { companyId, connectionId: connection.id, requestKey: randomUUID(), input: "A fixture prompt never persisted as input" } };
  }
  async function finished(fixture: Awaited<ReturnType<typeof seed>>, runId: string) {
    let result: Awaited<ReturnType<typeof fixture.broker.get>>;
    await vi.waitFor(async () => { result = await fixture.broker.get(fixture.companyId, fixture.pluginId, runId); expect(result && !["queued", "running"].includes(result.status)).toBe(true); }, { timeout: 5_000, interval: 20 });
    return result!;
  }
  it("uses an actual local HTTP mock with persisted pre-dispatch evidence, no plaintext input/key and a separate history lane", async () => {
    let calls = 0, body = "", auth = "", proof = false;
    const server = createServer(async (req, res) => {
      calls++; auth = req.headers.authorization ?? ""; for await (const chunk of req) body += chunk;
      const [run] = await db.select().from(spsModelRuns);
      proof = run?.status === "running" && run.externalEffects === "unknown" && run.credentialVersion === 1;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const fixture = await seed(globalThis.fetch, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`);
    const queued = await fixture.broker.submit(fixture.pluginId, fixture.input);
    const run = await finished(fixture, queued.id);
    expect(calls).toBe(1); expect(auth).toBe(`Bearer ${credential}`); expect(body).not.toContain(credential); expect(proof).toBe(true);
    expect(run).toMatchObject({ status: "succeeded", resultState: "available", result: { text: "Local mock answer", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });
    const stored = await db.select().from(spsModelRuns);
    expect(JSON.stringify(stored)).not.toContain(fixture.input.input); expect(JSON.stringify(stored)).not.toContain(credential);
    const history = spsExecutionHistoryService(db, fixture.pluginKey);
    const page = await history.list(fixture.companyId, { lane: "model_request" });
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ lane: "model_request", runtime: { kind: "model_api", modelSource: "configured" }, usage: { inputTokens: { value: 7, provenance: "reported" }, costUsd: { value: null, provenance: "unavailable" } } });
    expect(JSON.stringify(page)).not.toContain("Local mock answer"); expect(JSON.stringify(page)).not.toContain("endpoint");
    expect(await history.get(fixture.companyId, "model_request", run.id)).toMatchObject({ runId: run.id });
    const summary = await history.summarize(fixture.companyId, { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), lane: "model_request" });
    expect(summary.executionCount).toBe(1); expect(summary.tokens.inputTokens.reported).toBe(7); expect(summary.costs.other.unavailableExecutions).toBe(1);
  });
  it("deduplicates concurrent submissions and never replays an already-completed request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload)), fixture = await seed(fetch);
    const [first, duplicate] = await Promise.all([fixture.broker.submit(fixture.pluginId, fixture.input), fixture.broker.submit(fixture.pluginId, fixture.input)]);
    expect(first.id).toBe(duplicate.id); await finished(fixture, first.id);
    expect((await fixture.broker.submit(fixture.pluginId, fixture.input)).id).toBe(first.id); expect(fetch).toHaveBeenCalledOnce();
    await expect(fixture.broker.submit(fixture.pluginId, { ...fixture.input, input: "Changed" })).rejects.toThrow("already used"); expect(fetch).toHaveBeenCalledOnce();
  });
  it("checks grant/scope before resolving a credential or dispatching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload)), fixture = await seed(fetch);
    await fixture.connections.revoke(fixture.companyId, fixture.grant.id);
    await expect(fixture.broker.submit(fixture.pluginId, fixture.input)).rejects.toThrow();
    await expect(fixture.broker.submit(randomUUID(), fixture.input)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(await db.select().from(secretAccessEvents)).toEqual([]); expect(await db.select().from(spsModelRuns)).toEqual([]);
  });
  it("does not expose another Plugin or Workspace run", async () => {
    const fixture = await seed(), first = await fixture.broker.submit(fixture.pluginId, fixture.input); await finished(fixture, first.id);
    const other = await seed();
    expect(await other.broker.get(other.companyId, other.pluginId, first.id)).toBeNull();
    expect(await other.broker.cancel(other.companyId, other.pluginId, first.id)).toBeNull();
  });
  it("withholds a saved output after grant revocation, reapproval, or credential-version revocation", async () => {
    const fixture = await seed(), first = await fixture.broker.submit(fixture.pluginId, fixture.input); await finished(fixture, first.id);
    await fixture.connections.revoke(fixture.companyId, fixture.grant.id);
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, first.id)).toMatchObject({ status: "succeeded", resultState: "withheld", result: null });
    await fixture.connections.grant(fixture.companyId, fixture.connection.id, fixture.pluginId, "test-host");
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, first.id)).toMatchObject({ resultState: "withheld", result: null });
    const second = await fixture.broker.submit(fixture.pluginId, { ...fixture.input, requestKey: randomUUID() }); await finished(fixture, second.id);
    await db.update(companySecretVersions).set({ revokedAt: new Date() }).where(eq(companySecretVersions.secretId, fixture.secret.id));
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, second.id)).toMatchObject({ resultState: "withheld", result: null });
  });
  it("discards a result but retains reported usage if permission is revoked while the provider runs", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { finish = resolve; })), fixture = await seed(fetch);
    const first = await fixture.broker.submit(fixture.pluginId, fixture.input);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await fixture.connections.revoke(fixture.companyId, fixture.grant.id); finish(Response.json(payload));
    const run = await finished(fixture, first.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "permission_revoked", result: null });
    const [stored] = await db.select().from(spsModelRuns); expect(stored!.resultJson).toBeNull();
    expect(stored!.usageJson).toMatchObject({ spsUsageEvidence: { inputTokens: { value: 7, provenance: "reported" } } });
  });
  it("cancels a hanging request without claiming upstream termination or freeing unresolved resources", async () => {
    let finish!: (response: Response) => void;
    let tickCallback: (() => void) | undefined;
    const nativeSetInterval = globalThis.setInterval.bind(globalThis);
    const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 5_000) {
        tickCallback = handler as () => void;
        const interval = nativeSetInterval(handler, timeout, ...args);
        nativeClearInterval(interval);
        return interval;
      }
      return nativeSetInterval(handler, timeout, ...args);
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { finish = resolve; }));
    const lockReady = deferred();
    const releaseLock = deferred();
    let lockTask: Promise<void> | undefined;
    try {
      const fixture = await seed(fetch);
      intervalSpy.mockRestore();
      const first = await fixture.broker.submit(fixture.pluginId, fixture.input);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await fixture.broker.cancel(fixture.companyId, fixture.pluginId, first.id);
      expect(await finished(fixture, first.id)).toMatchObject({ status: "cancelled", externalEffects: "unknown", cleanupPending: true, result: null });
      await expect(fixture.broker.submit(fixture.pluginId, { ...fixture.input, requestKey: randomUUID() })).rejects.toThrow("busy");

      lockTask = db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE "sps_model_grants" IN ACCESS EXCLUSIVE MODE`);
        lockReady.resolve();
        await releaseLock.promise;
      });
      await lockReady.promise;
      expect(tickCallback).toBeTypeOf("function");
      tickCallback!();
      await vi.waitFor(async () => {
        const result = await db.execute(sql`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE NOT granted AND relation = 'sps_model_grants'::regclass
        ) AS waiting`);
        expect(result[0]?.waiting).toBe(true);
      });

      finish(Response.json(payload));
      await new Promise<void>(resolve => setImmediate(resolve));
      releaseLock.resolve();
      await lockTask;
      await vi.waitFor(async () => expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, first.id)).toMatchObject({ cleanupPending: false }));
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      intervalSpy.mockRestore();
      releaseLock.resolve();
      await lockTask?.catch(() => undefined);
    }
  });
  it("keeps locally unresolved work reserved after lease expiry and blocks another broker until cleanup settles", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { finish = resolve; })), fixture = await seed(fetch);
    const competingFetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload));
    const competingBroker = createSpsModelBroker(db, { fetch: competingFetch }); brokers.push(competingBroker);
    const submitted = await fixture.broker.submit(fixture.pluginId, fixture.input);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await db.update(spsModelRuns).set({ leaseExpiresAt: new Date(0) }).where(eq(spsModelRuns.id, submitted.id));

    await fixture.broker.recoverExpired();
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, submitted.id)).toMatchObject({
      status: "interrupted", errorCode: "lease_lost", externalEffects: "unknown", cleanupPending: true, result: null,
    });
    await competingBroker.recoverExpired();
    await expect(competingBroker.submit(fixture.pluginId, {
      ...fixture.input,
      requestKey: randomUUID(),
    })).rejects.toThrow("busy");
    expect(competingFetch).not.toHaveBeenCalled();
    expect(await db.select().from(spsModelRuns)).toHaveLength(1);

    finish(Response.json(payload));
    await vi.waitFor(async () => expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, submitted.id)).toMatchObject({
      status: "interrupted", cleanupPending: false, result: null,
    }));
    const [stored] = await db.select().from(spsModelRuns);
    expect(stored!.status).toBe("interrupted");
    expect(stored!.externalEffects).toBe("unknown");
    expect(stored!.resultJson).toBeNull();
  });
  it("recovers expired queued/running records as interrupted without replaying their key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload)), fixture = await seed(fetch);
    const inputHash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ connectionId: fixture.connection.id, input: fixture.input.input })).digest("hex");
    const [run] = await db.insert(spsModelRuns).values({ companyId: fixture.companyId, pluginId: fixture.pluginId, pluginKey: fixture.pluginKey, connectionId: fixture.connection.id,
      grantId: fixture.grant.id, grantRevision: fixture.grant.revision, requestKey: fixture.input.requestKey, inputHash, status: "running", externalEffects: "unknown", leaseOwnerId: randomUUID(), leaseExpiresAt: new Date(0) }).returning();
    await fixture.broker.recoverExpired();
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, run!.id)).toMatchObject({ status: "interrupted", errorCode: "process_lost", cleanupPending: false });
    expect((await fixture.broker.submit(fixture.pluginId, fixture.input)).id).toBe(run!.id); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses stale leases and never resumes another live Host's queued record", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(payload)), fixture = await seed(fetch);
    const inputHash = (await import("node:crypto")).createHash("sha256").update(JSON.stringify({ connectionId: fixture.connection.id, input: fixture.input.input })).digest("hex");
    const [run] = await db.insert(spsModelRuns).values({ companyId: fixture.companyId, pluginId: fixture.pluginId, pluginKey: fixture.pluginKey, connectionId: fixture.connection.id,
      grantId: fixture.grant.id, grantRevision: fixture.grant.revision, requestKey: fixture.input.requestKey, inputHash, status: "queued", leaseOwnerId: randomUUID(), leaseExpiresAt: sql`now() + interval '1 minute'` }).returning();
    await fixture.broker.recoverExpired(); expect((await fixture.broker.submit(fixture.pluginId, fixture.input)).id).toBe(run!.id);
    expect(await fixture.broker.get(fixture.companyId, fixture.pluginId, run!.id)).toMatchObject({ status: "queued", cleanupPending: true }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[401, "auth_required"], [429, "provider_limit"], [503, "provider_error"]])("does not retry provider HTTP %i or leak error bodies", async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(`private-provider-${credential}`, { status: status as number })), fixture = await seed(fetch);
    const first = await fixture.broker.submit(fixture.pluginId, fixture.input), run = await finished(fixture, first.id);
    expect(run).toMatchObject({ status: "failed", errorCode: code, result: null, externalEffects: "unknown" });
    expect(JSON.stringify(run)).not.toContain(credential); await fixture.broker.submit(fixture.pluginId, fixture.input); expect(fetch).toHaveBeenCalledOnce();
  });
});
