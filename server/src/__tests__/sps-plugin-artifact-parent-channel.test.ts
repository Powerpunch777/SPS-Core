import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { createSpsPluginArtifactParentChannel } from "../services/sps-plugin-artifact-parent-channel.js";
import { createSpsPluginArtifactReferenceReader, type SpsPluginArtifactReferenceScope,
  type SpsPluginArtifactReferenceReaders } from "../services/sps-plugin-artifact-references.js";
import { projectSpsSourceArtifactInventory, type SpsSourceArtifactInventory } from "../services/sps-source-artifact-inventory.js";

const TX = "11111111-1111-4111-8111-111111111111";
const TX_2 = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const ID_2 = "44444444-4444-4444-8444-444444444444";
const ID_3 = "55555555-5555-4555-8555-555555555555";
const REQUEST = "sps.plugin-artifacts.request";
const RESPONSE = "sps.plugin-artifacts.response";
const READY = "sps.plugin-artifacts.ready";
const FAILURE = "plugin_artifact_channel_unavailable";

class FakeChannel extends EventEmitter {
  connected = true;
  messages: any[] = [];

  send(message: unknown, callback: (error: Error | null) => void) {
    this.messages.push(structuredClone(message));
    queueMicrotask(() => callback(null));
    return true;
  }

  get channelId(): string {
    const frame = this.messages.find(message => message.kind === READY);
    if (!frame) throw new Error("Channel did not announce readiness.");
    return frame.channelId;
  }

  request(operation: "begin" | "check" | "end", id: string, transactionId = TX, extra = {}) {
    this.emit("message", { v: 1, kind: REQUEST, channelId: this.channelId, id, transactionId, operation, ...extra });
  }

  response(id: string, operation: "begin" | "check" | "end", transactionId = TX) {
    return this.messages.find(message => message.kind === RESPONSE && message.id === id
      && message.operation === operation && message.transactionId === transactionId);
  }
}

const roots = new Set<string>();
const owners: Array<{ dispose(): void }> = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture(readSourceInventory?: () => Promise<SpsSourceArtifactInventory>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sps-artifact-parent-channel-"));
  roots.add(root);
  const maintenance = createSpsPluginArtifactMaintenance();
  const readers: SpsPluginArtifactReferenceReaders = {
    listPlugins: async () => [],
    listPending: async () => [],
    listRetainedReviews: async () => [],
    readWorkers: () => [],
    readPreparations: () => [],
    readRegistryStages: async () => [],
    ...(readSourceInventory ? { readSourceInventory } : {}),
  };
  const reader = createSpsPluginArtifactReferenceReader({ localPluginDir: root, maintenance, readers });
  const channel = new FakeChannel();
  const owner = createSpsPluginArtifactParentChannel(reader, channel);
  owners.push(owner);
  await vi.waitFor(() => expect(channel.messages.some(message => message.kind === READY)).toBe(true));
  return { channel, maintenance, reader };
}

function controlledReader(maintenance: ReturnType<typeof createSpsPluginArtifactMaintenance>, scope: SpsPluginArtifactReferenceScope) {
  return {
    withSnapshot: <T>(action: (value: SpsPluginArtifactReferenceScope) => Promise<T>) => maintenance.withMaintenance(async () => {
      await scope.assertCurrent();
      try {
        const result = await action(scope);
        await scope.assertCurrent();
        return result;
      } finally { /* The production reader expires the scope at callback completion. */ }
    }),
  } as ReturnType<typeof createSpsPluginArtifactReferenceReader>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Core private plugin artifact parent channel", () => {
  it("returns Source inventory only on explicit supported begin and keeps legacy response shape", async () => {
    const inventory = projectSpsSourceArtifactInventory({ sources: [], grants: [] });
    const { channel } = await fixture(async () => inventory);
    channel.request("begin", ID, TX, { sourceInventory: true });
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true,
      snapshot: { sourceInventory: inventory } }));
    channel.request("end", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "end")).toMatchObject({ ok: true }));
    channel.request("begin", ID_3, TX_2);
    await vi.waitFor(() => {
      expect(channel.response(ID_3, "begin", TX_2)?.ok).toBe(true);
      expect(channel.response(ID_3, "begin", TX_2)?.snapshot).not.toHaveProperty("sourceInventory");
    });
    channel.request("end", "66666666-6666-4666-8666-666666666666", TX_2);
    await vi.waitFor(() => expect(channel.response("66666666-6666-4666-8666-666666666666", "end", TX_2)).toMatchObject({ ok: true }));
  });

  it("rejects requested Source coverage when the reader lacks it, without exposing a partial snapshot", async () => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID, TX, { sourceInventory: true });
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: false }));
    expect(channel.response(ID, "begin")).not.toHaveProperty("snapshot");
    await maintenance.withActivity(async () => {});
  });

  it("invalidates Source inventory changes during the actual held transaction", async () => {
    let inventory = projectSpsSourceArtifactInventory({ sources: [], grants: [] });
    const { channel } = await fixture(async () => inventory);
    channel.request("begin", ID, TX, { sourceInventory: true });
    await vi.waitFor(() => expect(channel.response(ID, "begin")?.ok).toBe(true));
    inventory = projectSpsSourceArtifactInventory({ sources: [{ kind: "workspace", id: TX, resourceId: TX,
      workspaceId: TX_2, route: null, status: "disabled", revision: "2026-11-01T00:00:00.000Z" }], grants: [] });
    channel.request("check", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "check")?.ok).toBe(false));
    channel.request("end", ID_3);
    await vi.waitFor(() => expect(channel.response(ID_3, "end")?.ok).toBe(false));
  });

  it("never admits a previously completed transaction again, even with a fresh request ID", async () => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));
    channel.request("end", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "end")).toMatchObject({ ok: true }));
    channel.request("begin", ID_3);
    await vi.waitFor(() => expect(channel.response(ID_3, "begin")).toMatchObject({ ok: false }));
    await maintenance.withActivity(async () => {});
  });
  it("holds actual Core maintenance from begin through check and final end acknowledgment", async () => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true,
      snapshot: { coverage: "core-only", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), references: [] } }));
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });

    channel.request("check", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "check")).toMatchObject({ ok: true }));
    channel.request("end", ID_3);
    await vi.waitFor(() => expect(channel.response(ID_3, "end")).toMatchObject({ ok: true }));
    await maintenance.withActivity(async () => {});
  });

  it("does not let malformed, wrong-scope, or duplicate-ID requests release the hold", async () => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));

    channel.request("end", ID_2, TX_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "end", TX_2)).toMatchObject({ ok: false, errorCode: FAILURE }));
    channel.emit("message", { v: 1, kind: REQUEST, channelId: channel.channelId, id: ID_3, transactionId: TX,
      operation: "check", extra: true });
    channel.request("check", ID);
    await vi.waitFor(() => expect(channel.messages.filter(message => message.kind === RESPONSE && message.id === ID)
      .some(message => message.ok === false)).toBe(true));
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });

    channel.request("end", "66666666-6666-4666-8666-666666666666");
    await vi.waitFor(() => expect(channel.response("66666666-6666-4666-8666-666666666666", "end"))
      .toMatchObject({ ok: false, errorCode: FAILURE }));
    await maintenance.withActivity(async () => {});
  });

  it("rejects a concurrent begin without disturbing the first transaction", async () => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));
    channel.request("begin", ID_2, TX_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "begin", TX_2)).toMatchObject({ ok: false, errorCode: FAILURE }));
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    channel.request("end", ID_3);
    await vi.waitFor(() => expect(channel.response(ID_3, "end")).toMatchObject({ ok: true }));
  });

  it("poisons a transaction when assertCurrent fails and releases only on matching end", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    let checks = 0;
    const scope = { coverage: "core-only", fingerprint: "a".repeat(64), references: [],
      assertCurrent: vi.fn(async () => { checks += 1; if (checks > 1) throw new Error("stale"); }) } as unknown as SpsPluginArtifactReferenceScope;
    const channel = new FakeChannel();
    const owner = createSpsPluginArtifactParentChannel(controlledReader(maintenance, scope), channel);
    owners.push(owner);
    await vi.waitFor(() => expect(channel.messages.some(message => message.kind === READY)).toBe(true));
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));
    channel.request("check", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "check")).toMatchObject({ ok: false, errorCode: FAILURE }));
    channel.request("check", ID_3);
    await vi.waitFor(() => expect(channel.response(ID_3, "check")).toMatchObject({ ok: false, errorCode: FAILURE }));
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    channel.request("end", "66666666-6666-4666-8666-666666666666");
    await vi.waitFor(() => expect(channel.response("66666666-6666-4666-8666-666666666666", "end"))
      .toMatchObject({ ok: false, errorCode: FAILURE }));
    await maintenance.withActivity(async () => {});
  });

  it("waits for an asynchronous check and Core postvalidation before acknowledging end", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const checkGate = deferred();
    const postGate = deferred();
    const checkStarted = deferred();
    const postStarted = deferred();
    let assertions = 0;
    const scope = { coverage: "core-only", fingerprint: "b".repeat(64), references: [],
      assertCurrent: vi.fn(async () => {
        assertions += 1;
        if (assertions === 2) { checkStarted.resolve(); await checkGate.promise; }
        if (assertions === 3) { postStarted.resolve(); await postGate.promise; }
      }) } as unknown as SpsPluginArtifactReferenceScope;
    const channel = new FakeChannel();
    const owner = createSpsPluginArtifactParentChannel(controlledReader(maintenance, scope), channel);
    owners.push(owner);
    await vi.waitFor(() => expect(channel.messages.some(message => message.kind === READY)).toBe(true));
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));
    channel.request("check", ID_2);
    await checkStarted.promise;
    channel.request("end", ID_3);
    await Promise.resolve();
    expect(channel.response(ID_3, "end")).toBeUndefined();

    checkGate.resolve();
    await vi.waitFor(() => expect(channel.response(ID_2, "check")).toMatchObject({ ok: true }));
    await postStarted.promise;
    expect(channel.response(ID_3, "end")).toBeUndefined();
    postGate.resolve();
    await vi.waitFor(() => expect(channel.response(ID_3, "end")).toMatchObject({ ok: true }));
  });

  it.each(["disconnect", "dispose"] as const)("does not release a held scope on %s", async action => {
    const { channel, maintenance } = await fixture();
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: true }));
    if (action === "disconnect") {
      channel.connected = false;
      channel.emit("disconnect");
    } else owners[owners.length - 1]!.dispose();
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
  });

  it("rejects a snapshot over 8 MiB before any snapshot frame escapes", async () => {
    const maintenance = createSpsPluginArtifactMaintenance();
    const scope = { coverage: "core-only", fingerprint: "c".repeat(64),
      references: [{ source: "plugin", ownerId: "large", state: "ready", path: "x".repeat(8 * 1024 * 1024),
        kind: "directory", canonicalPath: "x" }], assertCurrent: vi.fn(async () => {}) } as unknown as SpsPluginArtifactReferenceScope;
    const channel = new FakeChannel();
    const owner = createSpsPluginArtifactParentChannel(controlledReader(maintenance, scope), channel);
    owners.push(owner);
    await vi.waitFor(() => expect(channel.messages.some(message => message.kind === READY)).toBe(true));
    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toMatchObject({ ok: false, errorCode: FAILURE }));
    expect(channel.messages.some(message => message.kind === RESPONSE && message.ok === true)).toBe(false);
    await maintenance.withActivity(async () => {});
  });
});
