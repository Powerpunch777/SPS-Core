import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecretBindings, companySecrets, companySecretVersions, createDb, plugins, secretAccessEvents } from "@paperclipai/db";
import { createSpsBoundModelTextTransport, spsModelCredentialBindingPath } from "../services/sps-model-bound-transport.js";
import { SpsModelTransportError } from "../services/sps-model-transport.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
const credential = "fake-encrypted-model-key-for-bound-tests-only";
const transport = { endpoint: "https://mock-provider.example/v1/responses", model: "host-selected-test-model" };
const result = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Bound mock result" }] }] };

describeDb("Host-internal bound model credential primitive", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "1".repeat(64);
    temporary = await startEmbeddedPostgresTestDatabase("sps-bound-model-"); db = createDb(temporary.connectionString);
  }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents); await db.delete(companySecretBindings); await db.delete(companySecretVersions);
    await db.delete(companySecrets); await db.delete(plugins); await db.delete(companies);
  });
  afterAll(async () => {
    await temporary?.cleanup();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
  });
  async function workspace() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Bound model fixture", issuePrefix: `BM${id.slice(0, 7).toUpperCase()}` });
    return id;
  }
  async function seed() {
    const companyId = await workspace(), pluginId = randomUUID(), connectionId = randomUUID();
    const pluginKey = `sps.bound-model-${pluginId}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: pluginKey, version: "1.0.0", status: "ready",
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Bound mock", description: "Fixture only", author: "SPS", categories: ["automation"], capabilities: [], entrypoints: { worker: "./worker.js" } } });
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, { name: `bound-model-${randomUUID()}`, provider: "local_encrypted", value: credential });
    const binding = await secrets.createBinding({ companyId, secretId: secret.id, targetType: "plugin", targetId: pluginId, configPath: spsModelCredentialBindingPath(connectionId) });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(result));
    const configuration = { companyId, pluginId, connectionId, bindingId: binding!.id, transport };
    return { secrets, secret, binding: binding!, fetch, configuration, create: () => createSpsBoundModelTextTransport(db, configuration, { fetch }) };
  }
  async function rejected(pending: Promise<unknown>, code = "credential_unavailable") {
    await expect(pending).rejects.toMatchObject({ code, externalEffects: "not_dispatched" });
    try { await pending; } catch (error) {
      expect(error).toBeInstanceOf(SpsModelTransportError); expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toMatch(/fake-encrypted|private-provider|mock-provider|secretId/);
    }
  }
  it("reuses real encrypted Secret storage and existing binding/access audit without returning the key", async () => {
    const fixture = await seed();
    const [stored] = await db.select().from(companySecretVersions);
    expect(JSON.stringify(stored!.material)).not.toContain(credential);
    const output = await fixture.create().request({ input: "Bound request" });
    expect(output).toEqual({ status: "completed", text: "Bound mock result", refusal: null, usage: null });
    expect(fixture.fetch).toHaveBeenCalledOnce();
    expect(fixture.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${credential}` });
    expect(JSON.stringify(output)).not.toContain(credential);
    const events = await db.select().from(secretAccessEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId: fixture.configuration.companyId, pluginId: fixture.configuration.pluginId,
      consumerType: "plugin", consumerId: fixture.configuration.pluginId, configPath: spsModelCredentialBindingPath(fixture.configuration.connectionId),
      version: 1, outcome: "success" });
    expect(JSON.stringify(events)).not.toContain(credential);
  });
  it("sends an encrypted bound fixture credential to a real local HTTP mock, never in the prompt or returned output", async () => {
    const fixture = await seed(); let receivedKey = "", receivedBody = "";
    const server = createServer(async (req, res) => {
      receivedKey = req.headers.authorization ?? "";
      for await (const chunk of req) receivedBody += chunk;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const client = createSpsBoundModelTextTransport(db, { ...fixture.configuration,
        transport: { ...transport, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`, allowLoopbackHttp: true } });
      const output = await client.request({ input: "Bound fixture through the network" });
      expect(receivedKey).toBe(`Bearer ${credential}`); expect(receivedBody).not.toContain(credential);
      expect(output.text).toBe("Bound mock result"); expect(JSON.stringify(output)).not.toContain(credential);
    } finally {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  });
  it("checks binding Workspace, Plugin instance, purpose, connection and binding ID on every request", async () => {
    const fixture = await seed();
    const companyB = await workspace();
    for (const override of [{ companyId: companyB }, { pluginId: randomUUID() }, { connectionId: randomUUID() }, { bindingId: randomUUID() }]) {
      const client = createSpsBoundModelTextTransport(db, { ...fixture.configuration, ...override }, { fetch: fixture.fetch });
      await rejected(client.request({ input: "Denied" }));
    }
    await db.update(companySecretBindings).set({ configPath: "env.API_KEY" }).where(eq(companySecretBindings.id, fixture.binding.id));
    await rejected(fixture.create().request({ input: "Denied" }));
    expect(fixture.fetch).not.toHaveBeenCalled(); expect(await db.select().from(secretAccessEvents)).toEqual([]);
  });
  it("rejects an inconsistent cross-Workspace Secret association", async () => {
    const fixture = await seed(); const companyB = await workspace();
    const foreign = await fixture.secrets.create(companyB, { name: "foreign-model", provider: "local_encrypted", value: "fake-foreign-key-only" });
    await db.update(companySecretBindings).set({ secretId: foreign.id }).where(eq(companySecretBindings.id, fixture.binding.id));
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it.each(["disabled", "deleted", "unknown"])("does not resolve an inactive or unknown Secret (%s)", async status => {
    const fixture = await seed();
    await db.update(companySecrets).set({ status }).where(eq(companySecrets.id, fixture.secret.id));
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it.each(["disabled", "destroyed", "failed", "unknown"])("rejects a non-usable material version (%s)", async status => {
    const fixture = await seed();
    await db.update(companySecretVersions).set({ status }).where(eq(companySecretVersions.secretId, fixture.secret.id));
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it.each(["0", "01", "NaN", "Infinity", "9007199254740992"])("does not broaden an invalid version selector (%s)", async versionSelector => {
    const fixture = await seed();
    await db.update(companySecretBindings).set({ versionSelector }).where(eq(companySecretBindings.id, fixture.binding.id));
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("re-resolves latest per request after rotation but respects a pinned previous version", async () => {
    const fixture = await seed(); const client = fixture.create();
    await client.request({ input: "First" });
    const rotatedKey = "fake-rotated-model-key-only";
    await fixture.secrets.rotate(fixture.secret.id, { value: rotatedKey });
    await client.request({ input: "Second" });
    expect(fixture.fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${rotatedKey}` });
    await db.update(companySecretBindings).set({ versionSelector: "1" }).where(eq(companySecretBindings.id, fixture.binding.id));
    await client.request({ input: "Pinned" });
    expect(fixture.fetch.mock.calls[2]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${credential}` });
  });
  it("never treats previous material as latest, including the stale metadata formerly observable between two reads", async () => {
    const fixture = await seed();
    await fixture.secrets.rotate(fixture.secret.id, { value: "fake-current-model-key-only" });
    // Models the old split-read observation: a stale latest pointer, then post-rotation previous material.
    await db.update(companySecrets).set({ latestVersion: 1 }).where(eq(companySecrets.id, fixture.secret.id));
    await rejected(fixture.create().request({ input: "Do not use stale latest" }));
    expect(fixture.fetch).not.toHaveBeenCalled();
    await db.update(companySecretBindings).set({ versionSelector: "1" }).where(eq(companySecretBindings.id, fixture.binding.id));
    await expect(fixture.create().request({ input: "Explicitly pinned previous" })).resolves.toMatchObject({ text: "Bound mock result" });
  });
  it("rejects a binding removed while the provider resolves the credential", async () => {
    const fixture = await seed(); const resolve = localEncryptedProvider.resolveVersion;
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await resolve(input); await db.delete(companySecretBindings).where(eq(companySecretBindings.id, fixture.binding.id)); return value;
    });
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("rejects a latest credential rotated during asynchronous resolution, without retrying", async () => {
    const fixture = await seed(); const resolve = localEncryptedProvider.resolveVersion;
    const spy = vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await resolve(input); await fixture.secrets.rotate(fixture.secret.id, { value: "fake-new-credential-only" }); return value;
    });
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled(); expect(spy).toHaveBeenCalledOnce();
  });
  it("rejects credential version revocation during asynchronous resolution", async () => {
    const fixture = await seed(); const resolve = localEncryptedProvider.resolveVersion;
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await resolve(input); await db.update(companySecretVersions).set({ revokedAt: new Date() }).where(eq(companySecretVersions.secretId, fixture.secret.id)); return value;
    });
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("rejects a binding switched to another Secret during asynchronous resolution", async () => {
    const fixture = await seed(); const resolve = localEncryptedProvider.resolveVersion;
    const replacement = await fixture.secrets.create(fixture.configuration.companyId, { name: "replacement-model-key", provider: "local_encrypted", value: "fake-replacement-model-key-only" });
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await resolve(input); await db.update(companySecretBindings).set({ secretId: replacement.id }).where(eq(companySecretBindings.id, fixture.binding.id)); return value;
    });
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("sanitizes provider failures instead of surfacing secret references or raw errors", async () => {
    const fixture = await seed();
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(new Error(`private-provider-${credential}`));
    await rejected(fixture.create().request({ input: "Denied" })); expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("cancels before dispatch, including cancellation during credential resolution", async () => {
    const fixture = await seed(); const controller = new AbortController(); const client = fixture.create();
    const resolve = localEncryptedProvider.resolveVersion;
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockImplementationOnce(async input => {
      const value = await resolve(input); controller.abort(new Error(credential)); return value;
    });
    await rejected(client.request({ input: "Cancelled", signal: controller.signal }), "cancelled");
    await rejected(client.request({ input: "Already cancelled", signal: controller.signal }), "cancelled");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("validates identifiers and keeps the reserved binding path stable", async () => {
    const fixture = await seed();
    expect(spsModelCredentialBindingPath(fixture.configuration.connectionId.toUpperCase())).toBe(spsModelCredentialBindingPath(fixture.configuration.connectionId));
    for (const field of ["companyId", "pluginId", "connectionId", "bindingId"] as const) {
      expect(() => createSpsBoundModelTextTransport(db, { ...fixture.configuration, [field]: "not-an-id" }, { fetch: fixture.fetch })).toThrow(SpsModelTransportError);
    }
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
