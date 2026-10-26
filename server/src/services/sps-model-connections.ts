import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { companies, companySecretBindings, companySecretProviderConfigs, companySecrets, companySecretVersions, spsModelConnections, spsModelGrants, type Db } from "../compat/paperclip/db.js";
import { spsModelCredentialBindingPath } from "./sps-model-bound-transport.js";
import { normalizeSpsModelTextTransportConfiguration, type SpsModelTextTransportConfiguration } from "./sps-model-transport.js";
import { assertSpsPluginAvailable } from "./sps-plugin-availability.js";

type Connection = typeof spsModelConnections.$inferSelect;
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function requireSpsModelId(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error("Invalid model resource ID");
  return value.toLowerCase();
}
function selector(value: unknown) {
  if (value === undefined || value === "latest") return "latest";
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) return String(value);
  throw new Error("Use latest or a positive Secret version");
}
function label(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid model connection name");
  return value.trim();
}
function safeModel(value: string) {
  return /^[a-z0-9][a-z0-9._:/@+-]{0,119}$/i.test(value)
    && !/^[a-z]:[\\/]|^https?:|\.\.|[^@]+@[^@]+\.[^@]+|^(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|eyJ)/i.test(value) ? value : "unknown";
}
export function projectSpsModelConnection(connection: Connection) {
  return { id: connection.id, displayName: connection.displayName, protocol: "responses_text_v1" as const,
    model: safeModel(connection.model), state: connection.status === "active" ? "configured" as const : "disabled" as const,
    executionOwner: "host" as const, authorization: "grant_required" as const, readiness: "unknown" as const,
    limits: { timeoutMs: connection.timeoutMs, maxOutputTokens: connection.maxOutputTokens, maxRequestBytes: connection.maxRequestBytes, maxResponseBytes: connection.maxResponseBytes } };
}

/** Host mutations are called only behind assertSpsCoreHostAuthority. No Plugin may create grants. */
export function spsModelConnectionService(db: Db) {
  async function activeWorkspace(companyId: string) {
    const [workspace] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, companyId), eq(companies.status, "active")));
    if (!workspace) throw new Error("Workspace is unavailable");
  }
  async function connectionInWorkspace(companyId: string, connectionId: string) {
    const [connection] = await db.select().from(spsModelConnections).where(and(eq(spsModelConnections.companyId, companyId), eq(spsModelConnections.id, connectionId)));
    if (!connection) throw new Error("Model connection is unavailable");
    return connection;
  }
  async function checkSecret(companyId: string, secretId: string, versionSelector: string) {
    const [secret] = await db.select({ id: companySecrets.id }).from(companySecrets)
      .leftJoin(companySecretProviderConfigs, eq(companySecretProviderConfigs.id, companySecrets.providerConfigId))
      .innerJoin(companySecretVersions, and(eq(companySecretVersions.secretId, companySecrets.id), isNull(companySecretVersions.revokedAt),
        or(and(sql`${versionSelector} = 'latest'`, eq(companySecretVersions.version, companySecrets.latestVersion), eq(companySecretVersions.status, "current")),
          and(sql`${versionSelector} <> 'latest'`, eq(sql`${companySecretVersions.version}::text`, versionSelector), inArray(companySecretVersions.status, ["current", "previous"])))))
      .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId), eq(companySecrets.scope, "company"), eq(companySecrets.status, "active"),
        or(isNull(companySecrets.providerConfigId), and(eq(companySecretProviderConfigs.companyId, companyId), eq(companySecretProviderConfigs.provider, companySecrets.provider),
          inArray(companySecretProviderConfigs.status, ["ready", "warning"])))));
    if (!secret) throw new Error("Model credential is unavailable");
  }

  async function authorized(input: { companyId: string; pluginId: string; connectionId: string; grantId?: string; grantRevision?: number; credentialVersion?: number }, capability = "sps.models.submit") {
    const companyId = requireSpsModelId(input.companyId), pluginId = requireSpsModelId(input.pluginId), connectionId = requireSpsModelId(input.connectionId);
    const { pluginKey } = await assertSpsPluginAvailable(db, { companyId, pluginId }, capability);
    const [target] = await db.select({ connection: spsModelConnections, grant: spsModelGrants }).from(spsModelGrants)
      .innerJoin(spsModelConnections, and(eq(spsModelConnections.id, spsModelGrants.connectionId), eq(spsModelConnections.companyId, companyId)))
      .innerJoin(companySecretBindings, and(eq(companySecretBindings.id, spsModelGrants.bindingId), eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "plugin"), eq(companySecretBindings.targetId, pluginId),
        eq(companySecretBindings.configPath, spsModelCredentialBindingPath(connectionId)), eq(companySecretBindings.secretId, spsModelConnections.secretId),
        eq(companySecretBindings.versionSelector, spsModelConnections.versionSelector)))
      .where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.pluginId, pluginId), eq(spsModelGrants.connectionId, connectionId),
        eq(spsModelGrants.status, "active"), isNull(spsModelGrants.revokedAt), eq(spsModelConnections.status, "active"), eq(spsModelConnections.protocol, "responses_text_v1"),
        input.grantId === undefined ? undefined : eq(spsModelGrants.id, requireSpsModelId(input.grantId)),
        input.grantRevision === undefined ? undefined : eq(spsModelGrants.revision, input.grantRevision)));
    if (!target || !target.connection.secretId || !target.grant.bindingId) throw new Error("Model connection is unavailable");
    await checkSecret(companyId, target.connection.secretId, target.connection.versionSelector);
    if (input.credentialVersion !== undefined) {
      if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1) throw new Error("Model credential is unavailable");
      await checkSecret(companyId, target.connection.secretId, String(input.credentialVersion));
    }
    return { ...target, pluginKey };
  }

  return {
    authorized,
    async create(companyIdInput: string, input: { displayName: string; secretId: string; version?: number | "latest"; transport: SpsModelTextTransportConfiguration }, createdByUserId: string) {
      const companyId = requireSpsModelId(companyIdInput), secretId = requireSpsModelId(input.secretId);
      const config = normalizeSpsModelTextTransportConfiguration(input.transport), versionSelector = selector(input.version);
      const displayName = label(input.displayName);
      if (!createdByUserId || createdByUserId.length > 200) throw new Error("Host identity is required");
      await activeWorkspace(companyId); await checkSecret(companyId, secretId, versionSelector);
      return (await db.insert(spsModelConnections).values({ companyId, displayName, secretId, versionSelector,
        ...config, allowLoopbackHttp: input.transport.allowLoopbackHttp === true, createdByUserId }).returning())[0]!;
    },
    async listHost(companyIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput); await activeWorkspace(companyId);
      return db.select().from(spsModelConnections).where(eq(spsModelConnections.companyId, companyId)).orderBy(desc(spsModelConnections.createdAt)).limit(100);
    },
    async listForPlugin(companyIdInput: string, pluginIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput), pluginId = requireSpsModelId(pluginIdInput);
      await assertSpsPluginAvailable(db, { companyId, pluginId }, "sps.models.read");
      const rows = await db.select({ connection: spsModelConnections }).from(spsModelGrants)
        .innerJoin(spsModelConnections, and(eq(spsModelConnections.id, spsModelGrants.connectionId), eq(spsModelConnections.companyId, companyId)))
        .where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.pluginId, pluginId), eq(spsModelGrants.status, "active"), isNull(spsModelGrants.revokedAt)))
        .orderBy(desc(spsModelConnections.createdAt)).limit(100);
      return rows.map(row => projectSpsModelConnection(row.connection));
    },
    async grant(companyIdInput: string, connectionIdInput: string, pluginIdInput: string, createdByUserId: string) {
      const companyId = requireSpsModelId(companyIdInput), connectionId = requireSpsModelId(connectionIdInput), pluginId = requireSpsModelId(pluginIdInput);
      await assertSpsPluginAvailable(db, { companyId, pluginId }, "sps.models.submit");
      const connection = await connectionInWorkspace(companyId, connectionId);
      if (connection.status !== "active" || !connection.secretId) throw new Error("Model connection is unavailable");
      await checkSecret(companyId, connection.secretId, connection.versionSelector);
      return db.transaction(async tx => {
        await tx.select({ id: spsModelConnections.id }).from(spsModelConnections).where(and(eq(spsModelConnections.companyId, companyId), eq(spsModelConnections.id, connectionId), eq(spsModelConnections.status, "active"))).for("update").then(rows => { if (!rows[0]) throw new Error("Model connection is unavailable"); });
        const configPath = spsModelCredentialBindingPath(connectionId);
        let [binding] = await tx.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"), eq(companySecretBindings.targetId, pluginId), eq(companySecretBindings.configPath, configPath)));
        if (binding && (binding.secretId !== connection.secretId || binding.versionSelector !== connection.versionSelector)) throw new Error("Model credential binding conflicts with the Host connection");
        if (!binding) [binding] = await tx.insert(companySecretBindings).values({ companyId, secretId: connection.secretId!, targetType: "plugin", targetId: pluginId, configPath,
          versionSelector: connection.versionSelector }).returning();
        const [existing] = await tx.select().from(spsModelGrants).where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.connectionId, connectionId), eq(spsModelGrants.pluginId, pluginId)));
        if (existing?.status === "active" && !existing.revokedAt && existing.bindingId === binding!.id) return existing;
        if (existing && existing.revision >= 2_147_483_647) throw new Error("Model grant revision is exhausted");
        if (existing) return (await tx.update(spsModelGrants).set({ bindingId: binding!.id, status: "active", revokedAt: null, revision: existing.revision + 1,
          createdByUserId, updatedAt: new Date() }).where(eq(spsModelGrants.id, existing.id)).returning())[0]!;
        return (await tx.insert(spsModelGrants).values({ companyId, connectionId, pluginId, bindingId: binding!.id, createdByUserId }).returning())[0]!;
      });
    },
    async revoke(companyIdInput: string, grantIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput), grantId = requireSpsModelId(grantIdInput);
      return db.transaction(async tx => {
        const [grant] = await tx.select().from(spsModelGrants).where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.id, grantId))).for("update");
        if (!grant) throw new Error("Model grant is unavailable");
        await tx.update(spsModelGrants).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() }).where(eq(spsModelGrants.id, grant.id));
        if (grant.bindingId) await tx.delete(companySecretBindings).where(and(eq(companySecretBindings.id, grant.bindingId), eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "plugin"), eq(companySecretBindings.targetId, grant.pluginId), eq(companySecretBindings.configPath, spsModelCredentialBindingPath(grant.connectionId))));
      });
    },
    async setStatus(companyIdInput: string, connectionIdInput: string, status: "active" | "disabled") {
      const companyId = requireSpsModelId(companyIdInput), connectionId = requireSpsModelId(connectionIdInput);
      if (status !== "active" && status !== "disabled") throw new Error("Invalid model connection status");
      const connection = await connectionInWorkspace(companyId, connectionId);
      await db.transaction(async tx => {
        await tx.update(spsModelConnections).set({ status, updatedAt: new Date() }).where(and(eq(spsModelConnections.companyId, companyId), eq(spsModelConnections.id, connection.id)));
        if (status === "disabled") await tx.update(spsModelGrants).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.connectionId, connection.id)));
      });
      return connectionInWorkspace(companyId, connectionId);
    },
    async listGrants(companyIdInput: string, connectionIdInput: string) {
      const companyId = requireSpsModelId(companyIdInput), connectionId = requireSpsModelId(connectionIdInput);
      await connectionInWorkspace(companyId, connectionId);
      return db.select().from(spsModelGrants).where(and(eq(spsModelGrants.companyId, companyId), eq(spsModelGrants.connectionId, connectionId))).limit(100);
    },
  };
}
