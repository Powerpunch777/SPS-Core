import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins, type Db } from "@paperclipai/db";
import { pluginStateStore, type PluginStateExpectation } from "../services/plugin-state-store.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("conditional Plugin state input", () => {
  it("rejects malformed expectations before accessing a database or evaluating getters", async () => {
    const store = pluginStateStore({} as Db);
    const input = { scopeKind: "company" as const, scopeId: randomUUID(), stateKey: "head", value: { revision: 1 } };
    let accessed = false;
    const accessor = Object.defineProperty({}, "exists", { enumerable: true, get() { accessed = true; return false; } });
    const invalid = [null, [], {}, { exists: "false" }, { exists: false, value: null },
      { exists: true }, { exists: true, value: undefined }, { exists: false, extra: true }, accessor,
      Object.create({ exists: false })];
    for (const expected of invalid) {
      await expect(store.compareAndSet(randomUUID(), input, expected as PluginStateExpectation)).rejects.toBeInstanceOf(TypeError);
    }
    expect(accessed).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

databaseSuite("atomic conditional Plugin state on PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let peer: Db;
  let pluginId: string;
  let otherPluginId: string;
  const scopeId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-state-cas-");
    db = createDb(database.connectionString);
    peer = createDb(database.connectionString);
    pluginId = randomUUID();
    otherPluginId = randomUUID();
    for (const id of [pluginId, otherPluginId]) {
      const key = `sps.state-fixture-${id}`;
      await db.insert(plugins).values({ id, pluginKey: key, packageName: key, version: "1.0.0",
        manifestJson: { id: key, apiVersion: 1, version: "1.0.0", displayName: "State fixture", description: "Fixture",
          author: "SPS", categories: ["automation"], capabilities: [], entrypoints: { worker: "./fixture.js" } } });
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all([db?.$client.end(), peer?.$client.end()]);
    await database?.cleanup();
  }, 30_000);

  const key = (stateKey = randomUUID()) => ({ scopeKind: "company" as const, scopeId, namespace: "cas-test", stateKey });

  it("allows one creator across independent clients, including the null instance scope", async () => {
    for (const input of [key(), { scopeKind: "instance" as const, stateKey: randomUUID() }]) {
      const stores = [pluginStateStore(db), pluginStateStore(peer)];
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        stores[index % 2]!.compareAndSet(pluginId, { ...input, value: { revision: index } }, { exists: false })));
      expect(results.filter(result => result.swapped)).toHaveLength(1);
      const rows = await stores[0]!.list(pluginId, { scopeKind: input.scopeKind, namespace: "namespace" in input ? input.namespace : "default" });
      expect(rows.filter(row => row.stateKey === input.stateKey)).toHaveLength(1);
    }
  });

  it("prevents two writers from replacing the same base revision", async () => {
    const input = key();
    const first = pluginStateStore(db), second = pluginStateStore(peer);
    const base = { revision: randomUUID(), text: "base" };
    await first.set(pluginId, { ...input, value: base });
    const proposed = [{ revision: randomUUID(), text: "one" }, { revision: randomUUID(), text: "two" }];
    const results = await Promise.all([first, second].map((store, index) =>
      store.compareAndSet(pluginId, { ...input, value: proposed[index] }, { exists: true, value: base })));
    expect(results.filter(result => result.swapped)).toHaveLength(1);
    expect(await first.get(pluginId, input.scopeKind, input.stateKey, input)).toEqual(proposed[results.findIndex(result => result.swapped)]);
    expect(await first.compareAndSet(pluginId, { ...input, value: { revision: "stale" } }, { exists: true, value: base }))
      .toEqual({ swapped: false });
  });

  it("distinguishes missing rows from stored JSON null, false and zero", async () => {
    const store = pluginStateStore(db);
    for (const value of [null, false, 0]) {
      const input = key();
      expect(await store.compareAndSet(pluginId, { ...input, value }, { exists: true, value })).toEqual({ swapped: false });
      expect(await store.compareAndSet(pluginId, { ...input, value }, { exists: false })).toEqual({ swapped: true });
      expect(await store.compareAndSet(pluginId, { ...input, value: "wrong" }, { exists: false })).toEqual({ swapped: false });
      expect(await store.compareAndSet(pluginId, { ...input, value: "next" }, { exists: true, value })).toEqual({ swapped: true });
      expect(await store.compareAndSet(pluginId, { ...input, value: null }, { exists: true, value: "next" })).toEqual({ swapped: true });
      expect(await store.compareAndSet(pluginId, { ...input, value: "final" }, { exists: true, value: null })).toEqual({ swapped: true });
    }
  });

  it("uses JSONB equality and confines changes to the entire Plugin and scope key", async () => {
    const store = pluginStateStore(db), input = key();
    const base = { revision: "r1", nested: { a: 1, b: 2 } };
    await store.set(pluginId, { ...input, value: base });
    for (const [owner, selected] of [[otherPluginId, input], [pluginId, { ...input, scopeId: randomUUID() }],
      [pluginId, { ...input, namespace: "other" }], [pluginId, { ...input, stateKey: randomUUID() }]] as const) {
      expect(await store.compareAndSet(owner, { ...selected, value: "wrong" }, { exists: true, value: base })).toEqual({ swapped: false });
    }
    expect(await store.get(pluginId, input.scopeKind, input.stateKey, input)).toEqual(base);
    expect(await store.compareAndSet(pluginId, { ...input, value: { revision: "r2" } },
      { exists: true, value: { nested: { b: 2, a: 1 }, revision: "r1" } })).toEqual({ swapped: true });
  });

  it("preserves legacy writes and never recreates a deleted row for an expected value", async () => {
    const store = pluginStateStore(db), input = key();
    await store.set(pluginId, { ...input, value: { revision: "legacy" } });
    await store.delete(pluginId, input.scopeKind, input.stateKey, input);
    expect(await store.compareAndSet(pluginId, { ...input, value: "new" }, { exists: true, value: { revision: "legacy" } }))
      .toEqual({ swapped: false });
    expect(await store.get(pluginId, input.scopeKind, input.stateKey, input)).toBeNull();
    await expect(store.compareAndSet(randomUUID(), { ...input, value: "new" }, { exists: false })).rejects.toMatchObject({ status: 404 });
  });

  it("rolls back SQL when the trusted invocation is revoked before the transaction returns", async () => {
    const store = pluginStateStore(db), input = key();
    const services = buildHostServices(db, pluginId, `sps.state-fixture-${pluginId}`, createPluginEventBus(), undefined, { workspaceId: scopeId });
    let checks = 0;
    const revoked = async () => { if (++checks === 2) throw new Error("fixture invocation revoked"); };
    try {
      await expect(services.state.compareAndSet!({ ...input, value: { revision: "not-committed" }, expected: { exists: false } }, revoked))
        .rejects.toThrow("fixture invocation revoked");
      expect(checks).toBe(2);
      expect(await store.get(pluginId, input.scopeKind, input.stateKey, input)).toBeNull();
      await store.set(pluginId, { ...input, value: { revision: "original" } });
      checks = 0;
      await expect(services.state.compareAndSet!({ ...input, value: { revision: "not-committed" },
        expected: { exists: true, value: { revision: "original" } } }, revoked)).rejects.toThrow("fixture invocation revoked");
      expect(await store.get(pluginId, input.scopeKind, input.stateKey, input)).toEqual({ revision: "original" });
    } finally { services.dispose(); }
  });
});
