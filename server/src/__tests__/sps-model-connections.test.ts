import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  pluginCompanySettings,
  plugins,
  spsModelConnections,
  spsModelGrants,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { spsModelCredentialBindingPath } from "../services/sps-model-bound-transport.js";
import { spsModelConnectionService } from "../services/sps-model-connections.js";
import { secretService } from "../services/secrets.js";
import type { SpsModelTextTransportConfiguration } from "../services/sps-model-transport.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const fakeCredential = "fake-local-encrypted-model-key-for-connection-tests";
const baseTransport: SpsModelTextTransportConfiguration = {
  endpoint: "https://api.example.test/v1/responses",
  model: "fixture-model-v1",
  timeoutMs: 25_000,
  maxOutputTokens: 2_048,
  maxRequestBytes: 16_384,
  maxResponseBytes: 65_536,
  maxConcurrentRequests: 2,
};
const modelCapabilities = ["sps.models.read", "sps.models.submit"] as unknown as PaperclipPluginManifestV1["capabilities"];

type Db = ReturnType<typeof createDb>;
type Service = ReturnType<typeof spsModelConnectionService>;
type CreateInput = {
  displayName: string;
  secretId: string;
  version?: number | "latest";
  transport: SpsModelTextTransportConfiguration;
};

function manifest(id: string, overrides: Partial<PaperclipPluginManifestV1> = {}): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Model connection test Plugin",
    description: "Isolated DB fixture",
    author: "SPS test",
    categories: ["automation"],
    capabilities: modelCapabilities,
    entrypoints: { worker: "./worker.js" },
    ...overrides,
  };
}

describeEmbeddedPostgres("SPS Host model connections", () => {
  let db!: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "2".repeat(64);
    temporary = await startEmbeddedPostgresTestDatabase("sps-model-connections-");
    db = createDb(temporary.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(spsModelGrants);
    await db.delete(spsModelConnections);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(pluginCompanySettings);
    await db.delete(userSecretDefinitions);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
  });

  async function createWorkspace(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "SPS model connection fixture",
      issuePrefix: `MC${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  async function installPlugin(overrides: Partial<PaperclipPluginManifestV1> = {}) {
    const pluginId = randomUUID();
    const pluginKey = overrides.id ?? `sps.model-connection-test-${pluginId}`;
    const pluginManifest = manifest(pluginKey, overrides);
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: `@sps/model-connection-test-${pluginId}`,
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: "ready",
    });
    return { id: pluginId, pluginKey, manifest: pluginManifest };
  }

  async function createSecret(companyId: string, name = `model-key-${randomUUID()}`) {
    return secretService(db).create(companyId, {
      name,
      provider: "local_encrypted",
      value: fakeCredential,
    }, { userId: "test-host-owner" });
  }

  async function createConnection(
    service: Service,
    companyId: string,
    secretId: string,
    overrides: Partial<CreateInput> = {},
  ) {
    return service.create(companyId, {
      displayName: `Model ${randomUUID().slice(0, 8)}`,
      secretId,
      transport: { ...baseTransport },
      ...overrides,
    }, "test-host-owner");
  }

  async function seed() {
    const companyId = await createWorkspace();
    const plugin = await installPlugin();
    const secret = await createSecret(companyId);
    const service = spsModelConnectionService(db);
    const connection = await createConnection(service, companyId, secret.id);
    return { companyId, plugin, secret, service, connection };
  }

  it("creates canonical immutable HTTPS and explicit loopback records and lists them to the Host", async () => {
    const companyId = await createWorkspace();
    const secret = await createSecret(companyId);
    const service = spsModelConnectionService(db);
    const https = await createConnection(service, companyId, secret.id, {
      displayName: "  Primary model  ",
      transport: { ...baseTransport, endpoint: "HTTPS://API.EXAMPLE.TEST/v1/responses" },
    });
    expect(https).toMatchObject({
      companyId,
      displayName: "Primary model",
      protocol: "responses_text_v1",
      endpoint: "https://api.example.test/v1/responses",
      model: "fixture-model-v1",
      secretId: secret.id,
      versionSelector: "latest",
      status: "active",
      allowLoopbackHttp: false,
      timeoutMs: 25_000,
      maxOutputTokens: 2_048,
      maxRequestBytes: 16_384,
      maxResponseBytes: 65_536,
      maxConcurrentRequests: 2,
    });

    const loopback = await createConnection(service, companyId, secret.id, {
      displayName: "Local model",
      transport: {
        ...baseTransport,
        endpoint: "http://localhost:8088/v1/responses",
        allowLoopbackHttp: true,
      },
    });
    expect(loopback.endpoint).toBe("http://127.0.0.1:8088/v1/responses");
    expect(loopback.allowLoopbackHttp).toBe(true);

    const disabled = await service.setStatus(companyId, loopback.id, "disabled");
    expect(disabled).toMatchObject({
      id: loopback.id,
      status: "disabled",
      endpoint: loopback.endpoint,
      model: loopback.model,
      secretId: loopback.secretId,
      versionSelector: loopback.versionSelector,
    });

    const hostList = await service.listHost(companyId);
    expect(hostList).toHaveLength(2);
    expect(hostList.find((item) => item.id === https.id)).toMatchObject({ id: https.id, endpoint: https.endpoint });
    expect(hostList.find((item) => item.id === loopback.id)).toMatchObject({ id: loopback.id, status: "disabled" });
  });

  it("rejects invalid names, transport limits, and non-opted-in HTTP endpoints", async () => {
    const companyId = await createWorkspace();
    const secret = await createSecret(companyId);
    const service = spsModelConnectionService(db);

    await expect(createConnection(service, companyId, secret.id, { displayName: " \t " })).rejects.toThrow();
    await expect(createConnection(service, companyId, secret.id, {
      transport: { ...baseTransport, maxConcurrentRequests: 17 },
    })).rejects.toThrow();
    await expect(createConnection(service, companyId, secret.id, {
      transport: { ...baseTransport, maxRequestBytes: 1_048_576, maxResponseBytes: 4_194_304, maxConcurrentRequests: 2 },
    })).rejects.toThrow();
    await expect(createConnection(service, companyId, secret.id, {
      transport: { ...baseTransport, endpoint: "http://provider.example.test/v1/responses" },
    })).rejects.toThrow();
    await expect(createConnection(service, companyId, secret.id, {
      transport: { ...baseTransport, endpoint: "http://127.0.0.1:8088/v1/responses" },
    })).rejects.toThrow();
    expect(await service.listHost(companyId)).toEqual([]);
  });

  it("requires a current company Secret and accepts a pinned previous version", async () => {
    const companyId = await createWorkspace();
    const foreignCompanyId = await createWorkspace();
    const secret = await createSecret(companyId);
    const foreignSecret = await createSecret(foreignCompanyId);
    const secrets = secretService(db);
    await secrets.rotate(secret.id, { value: "fake-rotated-local-model-key" });
    const service = spsModelConnectionService(db);

    const pinned = await createConnection(service, companyId, secret.id, { version: 1 });
    expect(pinned.versionSelector).toBe("1");
    await expect(createConnection(service, companyId, foreignSecret.id)).rejects.toThrow();
    await expect(createConnection(service, companyId, secret.id, { version: 99 })).rejects.toThrow();

    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret.id));
    await expect(createConnection(service, companyId, secret.id)).rejects.toThrow();
  });

  it("rejects user-scoped Secrets", async () => {
    const companyId = await createWorkspace();
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(companyId, {
      key: `model-key-${randomUUID()}`,
      name: "User model key",
      provider: "local_encrypted",
    }, { userId: "test-host-owner" });
    const userSecret = await secrets.createCurrentUserSecretValue(companyId, "fixture-user", {
      definitionId: definition.id,
      value: fakeCredential,
    }, { userId: "test-host-owner" });
    const service = spsModelConnectionService(db);

    await expect(createConnection(service, companyId, userSecret.id)).rejects.toThrow();
  });

  it("returns only same-Workspace approved Plugin projections without endpoint or credential references", async () => {
    const fixture = await seed();
    const otherPlugin = await installPlugin();
    const otherPluginConnection = await createConnection(
      fixture.service,
      fixture.companyId,
      fixture.secret.id,
    );
    const secondCompanyId = await createWorkspace();
    const secondSecret = await createSecret(secondCompanyId);
    const secondCompanyConnection = await createConnection(
      fixture.service,
      secondCompanyId,
      secondSecret.id,
    );
    const pluginGrant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    await fixture.service.grant(
      fixture.companyId,
      otherPluginConnection.id,
      otherPlugin.id,
      "test-host-owner",
    );
    await fixture.service.grant(
      secondCompanyId,
      secondCompanyConnection.id,
      fixture.plugin.id,
      "test-host-owner",
    );

    const projection = await fixture.service.listForPlugin(fixture.companyId, fixture.plugin.id);
    expect(projection).toEqual([{
      id: fixture.connection.id,
      displayName: fixture.connection.displayName,
      protocol: "responses_text_v1",
      model: fixture.connection.model,
      state: "configured",
      executionOwner: "host",
      authorization: "grant_required",
      readiness: "unknown",
      limits: {
        timeoutMs: fixture.connection.timeoutMs,
        maxOutputTokens: fixture.connection.maxOutputTokens,
        maxRequestBytes: fixture.connection.maxRequestBytes,
        maxResponseBytes: fixture.connection.maxResponseBytes,
      },
    }]);
    expect(JSON.stringify(projection)).not.toContain(fixture.connection.endpoint);
    expect(JSON.stringify(projection)).not.toContain(fixture.secret.id);
    expect(JSON.stringify(projection)).not.toContain(pluginGrant.bindingId);
    expect(JSON.stringify(projection)).not.toContain(fakeCredential);
    expect(projection[0]).not.toHaveProperty("secretId");
    expect(projection[0]).not.toHaveProperty("versionSelector");
    expect(projection[0]).not.toHaveProperty("bindingId");
  });

  it("makes grants idempotent and creates the exact Plugin credential binding", async () => {
    const fixture = await seed();
    const first = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    const second = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    const bindings = await db.select().from(companySecretBindings);

    expect(second).toMatchObject({ id: first.id, bindingId: first.bindingId, revision: 1, status: "active" });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      id: first.bindingId,
      companyId: fixture.companyId,
      secretId: fixture.secret.id,
      targetType: "plugin",
      targetId: fixture.plugin.id,
      configPath: spsModelCredentialBindingPath(fixture.connection.id),
      versionSelector: "latest",
    });
  });

  it("rejects wrong Workspace, Plugin, binding purpose, and Secret associations", async () => {
    const fixture = await seed();
    const foreignCompanyId = await createWorkspace();
    const otherPlugin = await installPlugin();
    const otherSecret = await createSecret(fixture.companyId);

    await expect(fixture.service.grant(
      foreignCompanyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    )).rejects.toThrow();
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: otherPlugin.id,
      connectionId: fixture.connection.id,
    })).rejects.toThrow();

    const grant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    await db.update(companySecretBindings)
      .set({ targetType: "agent" })
      .where(eq(companySecretBindings.id, grant.bindingId!));
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
    })).rejects.toThrow();

    await db.update(companySecretBindings)
      .set({ targetType: "plugin", secretId: otherSecret.id })
      .where(eq(companySecretBindings.id, grant.bindingId!));
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
    })).rejects.toThrow();
  });

  it("rechecks current Plugin lifecycle, capability, activation, and dependency state", async () => {
    const fixture = await seed();
    const grant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    const authorized = () => fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
      grantId: grant.id,
      grantRevision: grant.revision,
    });
    await expect(authorized()).resolves.toMatchObject({ grant: { id: grant.id } });

    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, fixture.plugin.id));
    await expect(authorized()).rejects.toThrow();
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, fixture.plugin.id));

    await db.update(plugins).set({
      manifestJson: { ...fixture.plugin.manifest, capabilities: ["sps.models.read"] as unknown as PaperclipPluginManifestV1["capabilities"] },
    }).where(eq(plugins.id, fixture.plugin.id));
    await expect(authorized()).rejects.toThrow();
    await db.update(plugins).set({ manifestJson: fixture.plugin.manifest }).where(eq(plugins.id, fixture.plugin.id));

    await db.insert(pluginCompanySettings).values({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      enabled: false,
      settingsJson: {},
    });
    await expect(authorized()).rejects.toThrow();
    await db.update(pluginCompanySettings).set({ enabled: true }).where(and(
      eq(pluginCompanySettings.companyId, fixture.companyId),
      eq(pluginCompanySettings.pluginId, fixture.plugin.id),
    ));

    const dependencyId = `sps.model-connection-required-${randomUUID()}`;
    await db.update(plugins).set({
      manifestJson: {
        ...fixture.plugin.manifest,
        requiredDependencies: [{ id: dependencyId, minVersion: "1.0.0", maxVersion: "1.0.0" }],
      },
    }).where(eq(plugins.id, fixture.plugin.id));
    await expect(authorized()).rejects.toThrow();
    await installPlugin({ id: dependencyId, version: "1.0.0" });
    await expect(authorized()).resolves.toMatchObject({ grant: { id: grant.id } });
  });

  it("revoke deletes only its binding and makes the grant unavailable", async () => {
    const fixture = await seed();
    const otherPlugin = await installPlugin();
    const ownGrant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    const otherGrant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      otherPlugin.id,
      "test-host-owner",
    );

    await fixture.service.revoke(fixture.companyId, ownGrant.id);
    const bindings = await db.select().from(companySecretBindings);
    expect(bindings.map((binding) => binding.id)).toEqual([otherGrant.bindingId]);
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
    })).rejects.toThrow();
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: otherPlugin.id,
      connectionId: fixture.connection.id,
    })).resolves.toMatchObject({ grant: { id: otherGrant.id } });
  });

  it("increments grant revision on regrant and rejects authorization with the old revision", async () => {
    const fixture = await seed();
    const first = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    await fixture.service.revoke(fixture.companyId, first.id);
    const second = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );

    expect(second).toMatchObject({ id: first.id, revision: first.revision + 1, status: "active" });
    expect(second.bindingId).not.toBe(first.bindingId);
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
      grantId: first.id,
      grantRevision: first.revision,
    })).rejects.toThrow();
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
      grantId: second.id,
      grantRevision: second.revision,
    })).resolves.toMatchObject({ grant: { revision: second.revision } });
  });

  it("does not reactivate grants when a disabled connection is re-enabled", async () => {
    const fixture = await seed();
    const grant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );

    await fixture.service.setStatus(fixture.companyId, fixture.connection.id, "disabled");
    await fixture.service.setStatus(fixture.companyId, fixture.connection.id, "active");
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
    })).rejects.toThrow();
    await expect(fixture.service.listForPlugin(fixture.companyId, fixture.plugin.id)).resolves.toEqual([]);

    const regranted = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    expect(regranted.revision).toBe(grant.revision + 1);
    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
    })).resolves.toMatchObject({ grant: { revision: regranted.revision } });
  });

  it("serializes concurrent grants to one grant and one binding", async () => {
    const fixture = await seed();
    const grants = await Promise.all(Array.from({ length: 8 }, () => fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    )));
    const rows = await db.select().from(spsModelGrants);
    const bindings = await db.select().from(companySecretBindings);

    expect(new Set(grants.map((grant) => grant.id)).size).toBe(1);
    expect(new Set(grants.map((grant) => grant.revision))).toEqual(new Set([1]));
    expect(rows).toHaveLength(1);
    expect(bindings).toHaveLength(1);
  });

  it("denies authorization after a binding is corrupted to reference another Workspace Secret", async () => {
    const fixture = await seed();
    const foreignCompanyId = await createWorkspace();
    const foreignSecret = await createSecret(foreignCompanyId);
    const grant = await fixture.service.grant(
      fixture.companyId,
      fixture.connection.id,
      fixture.plugin.id,
      "test-host-owner",
    );
    await db.update(companySecretBindings)
      .set({ secretId: foreignSecret.id })
      .where(eq(companySecretBindings.id, grant.bindingId!));

    await expect(fixture.service.authorized({
      companyId: fixture.companyId,
      pluginId: fixture.plugin.id,
      connectionId: fixture.connection.id,
      grantId: grant.id,
      grantRevision: grant.revision,
    })).rejects.toThrow();
  });
});
