import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { companySecretBindings, companySecrets, companySecretVersions, type Db } from "../compat/paperclip/db.js";
import { secretService } from "./secrets.js";
import { createSpsModelTextTransport, SpsModelTransportError, type SpsModelTextTransportConfiguration } from "./sps-model-transport.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function spsModelCredentialBindingPath(connectionId: string) {
  if (typeof connectionId !== "string" || !uuid.test(connectionId)) throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  return `sps.models.${connectionId.toLowerCase()}.apiKey`;
}

/**
 * Host-internal Secret binding primitive, not a public broker or execution grant.
 * A future caller must supply authenticated invocation scope and recheck Plugin capability,
 * Workspace activation and a Host-approved durable connection/egress grant before calling it.
 */
export function createSpsBoundModelTextTransport(
  db: Db,
  configuration: {
    companyId: string;
    pluginId: string;
    connectionId: string;
    bindingId: string;
    transport: SpsModelTextTransportConfiguration;
  },
  dependencies: { fetch?: typeof globalThis.fetch } = {},
) {
  const { companyId, pluginId, connectionId, bindingId } = configuration;
  if (![companyId, pluginId, bindingId].every(value => typeof value === "string" && uuid.test(value))) {
    throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  }
  const configPath = spsModelCredentialBindingPath(connectionId);
  const transport = createSpsModelTextTransport(configuration.transport, dependencies);
  const secrets = secretService(db);

  async function readBinding() {
    // One statement snapshot binds the selector to its usable version. Separate reads could
    // otherwise observe an old latestVersion followed by its newly rotated 'previous' material.
    const [binding] = await db.select({ secretId: companySecretBindings.secretId, selector: companySecretBindings.versionSelector,
      version: companySecretVersions.version }).from(companySecretBindings)
      .innerJoin(companySecrets, eq(companySecrets.id, companySecretBindings.secretId))
      .innerJoin(companySecretVersions, and(eq(companySecretVersions.secretId, companySecrets.id), isNull(companySecretVersions.revokedAt),
        or(and(eq(companySecretBindings.versionSelector, "latest"), eq(companySecretVersions.version, companySecrets.latestVersion), eq(companySecretVersions.status, "current")),
          and(ne(companySecretBindings.versionSelector, "latest"), eq(companySecretBindings.versionSelector, sql`${companySecretVersions.version}::text`),
            inArray(companySecretVersions.status, ["current", "previous"])))))
      .where(and(eq(companySecretBindings.id, bindingId), eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "plugin"), eq(companySecretBindings.targetId, pluginId), eq(companySecretBindings.configPath, configPath),
        eq(companySecrets.companyId, companyId), eq(companySecrets.scope, "company"), eq(companySecrets.status, "active")));
    if (!binding || !Number.isSafeInteger(binding.version) || binding.version < 1) {
      throw new SpsModelTransportError("credential_unavailable", "not_dispatched");
    }
    return binding;
  }

  return Object.freeze({
    async request(input: { input: string; signal?: AbortSignal }) {
      return transport.request({ input: input.input, signal: input.signal, credential: async signal => {
        const before = await readBinding();
        if (signal.aborted) throw new Error("Model credential resolution cancelled");
        const credential = await secrets.resolveSecretValue(companyId, before.secretId, before.version, {
          consumerType: "plugin", consumerId: pluginId, configPath, allowedBindingIds: [bindingId],
          actorType: "plugin", actorId: pluginId, pluginId,
        });
        if (signal.aborted) throw new Error("Model credential resolution cancelled");
        // Re-read after asynchronous provider resolution; never dispatch a removed, rebound or newly rotated latest binding.
        const after = await readBinding();
        if (before.secretId !== after.secretId || before.selector !== after.selector || before.version !== after.version) {
          throw new SpsModelTransportError("credential_unavailable", "not_dispatched");
        }
        return credential;
      } });
    },
  });
}
