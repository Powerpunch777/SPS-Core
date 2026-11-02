import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";
import type {
  PluginStateScopeKind,
  SetPluginState,
  ListPluginState,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default namespace used when the plugin does not specify one. */
const DEFAULT_NAMESPACE = "default";

export type PluginStateExpectation =
  | { exists: false }
  | { exists: true; value: unknown };

function validateExpectation(value: unknown): PluginStateExpectation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Plugin state expectation must be a plain record");
  }

  let prototype: object | null;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError("Plugin state expectation must be a plain record");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Plugin state expectation must be a plain record");
  }

  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("Plugin state expectation must contain enumerable data properties only");
      }
      descriptors.set(key, descriptor);
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Plugin state expectation must be a plain record");
  }

  const exists = descriptors.get("exists")?.value;
  if (exists === false && keys.length === 1 && keys[0] === "exists") {
    return { exists: false };
  }
  if (exists === true && keys.length === 2 && keys.includes("value") && keys.includes("exists")) {
    const expectedValue = descriptors.get("value")?.value;
    if (expectedValue === undefined) {
      throw new TypeError("Plugin state expectation value cannot be undefined");
    }
    return { exists: true, value: expectedValue };
  }
  throw new TypeError("Invalid Plugin state expectation");
}

/**
 * Build the WHERE clause conditions for a scoped state lookup.
 *
 * The five-part composite key is:
 *   `(pluginId, scopeKind, scopeId, namespace, stateKey)`
 *
 * `scopeId` may be null (for `instance` scope) or a non-empty string.
 */
function scopeConditions(
  pluginId: string,
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined | null,
  namespace: string,
  stateKey: string,
) {
  const conditions = [
    eq(pluginState.pluginId, pluginId),
    eq(pluginState.scopeKind, scopeKind),
    eq(pluginState.namespace, namespace),
    eq(pluginState.stateKey, stateKey),
  ];

  if (scopeId != null && scopeId !== "") {
    conditions.push(eq(pluginState.scopeId, scopeId));
  } else {
    conditions.push(isNull(pluginState.scopeId));
  }

  return and(...conditions);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Plugin State Store — scoped key-value persistence for plugin workers.
 *
 * Provides `get`, `set`, `delete`, and `list` operations over the
 * `plugin_state` table. Each plugin's data is strictly namespaced by
 * `pluginId` so plugins cannot read or write each other's state.
 *
 * This service implements the server-side backing for the `ctx.state` SDK
 * client exposed to plugin workers. The host is responsible for:
 * - enforcing `plugin.state.read` capability before calling `get` / `list`
 * - enforcing `plugin.state.write` capability before calling `set` / `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface (`ctx.state`)
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Plugin State
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state` table
 */
export function pluginStateStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function assertPluginExists(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    if (rows.length === 0) {
      throw notFound(`Plugin not found: ${pluginId}`);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Read a state value.
     *
     * Returns the stored JSON value, or `null` if no entry exists for the
     * given scope and key.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param stateKey - The key to read
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    get: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<unknown> => {
      const rows = await db
        .select()
        .from(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));

      return rows[0]?.valueJson ?? null;
    },

    /**
     * Write (create or replace) a state value.
     *
     * Uses an upsert so the caller does not need to check for prior existence.
     * On conflict (same composite key) the existing row's `value_json` and
     * `updated_at` are overwritten.
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param input - Scope key and value to store
     */
    set: async (pluginId: string, input: SetPluginState): Promise<void> => {
      await assertPluginExists(pluginId);

      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      const scopeId = input.scopeId ?? null;

      await db
        .insert(pluginState)
        .values({
          pluginId,
          scopeKind: input.scopeKind,
          scopeId,
          namespace,
          stateKey: input.stateKey,
          valueJson: input.value,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            pluginState.pluginId,
            pluginState.scopeKind,
            pluginState.scopeId,
            pluginState.namespace,
            pluginState.stateKey,
          ],
          set: {
            valueJson: input.value,
            updatedAt: new Date(),
          },
        });
    },

    /**
     * Atomically create a missing value or replace a value that still matches
     * the supplied JSON expectation. Callers must include a revision in their
     * value when they need ABA detection. This primitive does not provide
     * multi-key transactions or permission-revocation guarantees.
     */
    compareAndSet: async (
      pluginId: string,
      input: SetPluginState,
      rawExpected: PluginStateExpectation,
    ): Promise<{ swapped: boolean }> => {
      const expected = validateExpectation(rawExpected);
      const expectedJson = expected.exists ? JSON.stringify(expected.value) : undefined;
      if (expected.exists && expectedJson === undefined) {
        throw new TypeError("Plugin state expectation value must be JSON-serializable");
      }
      const valueJson = JSON.stringify(input.value);
      if (valueJson === undefined) throw new TypeError("Plugin state value must be JSON-serializable");

      await assertPluginExists(pluginId);

      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      const scopeId = input.scopeId ?? null;
      const conditions = scopeConditions(
        pluginId,
        input.scopeKind,
        scopeId,
        namespace,
        input.stateKey,
      );

      if (!expected.exists) {
        const rows = await db
          .insert(pluginState)
          .values({
            pluginId,
            scopeKind: input.scopeKind,
            scopeId,
            namespace,
            stateKey: input.stateKey,
            valueJson: sql`${valueJson}::jsonb`,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({
            target: [
              pluginState.pluginId,
              pluginState.scopeKind,
              pluginState.scopeId,
              pluginState.namespace,
              pluginState.stateKey,
            ],
          })
          .returning({ id: pluginState.id });
        return { swapped: rows.length > 0 };
      }

      const rows = await db
        .update(pluginState)
        .set({ valueJson: sql`${valueJson}::jsonb`, updatedAt: new Date() })
        .where(and(
          conditions,
          sql`${pluginState.valueJson} = ${expectedJson}::jsonb`,
        ))
        .returning({ id: pluginState.id });
      return { swapped: rows.length > 0 };
    },

    /**
     * Delete a state value.
     *
     * No-ops silently if the entry does not exist (idempotent by design).
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param stateKey - The key to delete
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    delete: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<void> => {
      await db
        .delete(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));
    },

    /**
     * List all state entries for a plugin, optionally filtered by scope.
     *
     * Returns all matching rows as `PluginStateRecord`-shaped objects.
     * The `valueJson` field contains the stored value.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param filter - Optional scope filters (scopeKind, scopeId, namespace)
     */
    list: async (pluginId: string, filter: ListPluginState = {}): Promise<typeof pluginState.$inferSelect[]> => {
      const conditions = [eq(pluginState.pluginId, pluginId)];

      if (filter.scopeKind !== undefined) {
        conditions.push(eq(pluginState.scopeKind, filter.scopeKind));
      }
      if (filter.scopeId !== undefined) {
        conditions.push(eq(pluginState.scopeId, filter.scopeId));
      }
      if (filter.namespace !== undefined) {
        conditions.push(eq(pluginState.namespace, filter.namespace));
      }

      return db
        .select()
        .from(pluginState)
        .where(and(...conditions));
    },

    /**
     * Delete all state entries owned by a plugin.
     *
     * Called during plugin uninstall when `removeData = true`. Also useful
     * for resetting a plugin's state during testing.
     *
     * @param pluginId - UUID of the owning plugin
     */
    deleteAll: async (pluginId: string): Promise<void> => {
      await db
        .delete(pluginState)
        .where(eq(pluginState.pluginId, pluginId));
    },
  };
}

export type PluginStateStore = ReturnType<typeof pluginStateStore>;
