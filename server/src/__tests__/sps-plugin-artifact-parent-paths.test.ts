import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsPluginArtifactMaintenance } from "../services/sps-plugin-artifact-maintenance.js";
import { createSpsPluginArtifactParentChannel } from "../services/sps-plugin-artifact-parent-channel.js";
import { createSpsPluginArtifactReferenceReader, type SpsPluginArtifactReferenceReaders } from "../services/sps-plugin-artifact-references.js";

const TX = "11111111-1111-4111-8111-111111111111";
const TX_2 = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const ID_2 = "44444444-4444-4444-8444-444444444444";
const ID_3 = "55555555-5555-4555-8555-555555555555";
const ID_4 = "66666666-6666-4666-8666-666666666666";
const REQUEST = "sps.plugin-artifacts.request";
const RESPONSE = "sps.plugin-artifacts.response";
const READY = "sps.plugin-artifacts.ready";
const FAILURE = "plugin_artifact_channel_unavailable";
const MAX_PARENT_PATHS = 4096;

type ParentPath = { source: string; ownerId: string; state: string; path: string; kind: "file" | "directory" };

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

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sps-artifact-parent-paths-"));
  roots.add(root);
  const maintenance = createSpsPluginArtifactMaintenance();
  const listPlugins = vi.fn(async () => []);
  const readers: SpsPluginArtifactReferenceReaders = {
    listPlugins,
    listPending: async () => [],
    listRetainedReviews: async () => [],
    readWorkers: () => [],
    readPreparations: () => [],
    readRegistryStages: async () => [],
  };
  const reader = createSpsPluginArtifactReferenceReader({ localPluginDir: root, maintenance, readers });
  const channel = new FakeChannel();
  const owner = createSpsPluginArtifactParentChannel(reader, channel);
  owners.push(owner);
  await vi.waitFor(() => expect(channel.messages.some(message => message.kind === READY)).toBe(true));
  return { root, channel, maintenance, listPlugins };
}

function parentPath(referencePath: string, kind: ParentPath["kind"] = "file", ownerId = "parent-artifact") {
  return { source: "direct-parent", ownerId, state: "protected", path: referencePath, kind } satisfies ParentPath;
}

async function begin(channel: FakeChannel, parentPaths: ParentPath[], id = ID, transactionId = TX) {
  channel.request("begin", id, transactionId, { parentPaths });
  await vi.waitFor(() => expect(channel.response(id, "begin", transactionId)).toBeDefined());
  return channel.response(id, "begin", transactionId);
}

async function end(channel: FakeChannel, id = ID_2, transactionId = TX) {
  channel.request("end", id, transactionId);
  await vi.waitFor(() => expect(channel.response(id, "end", transactionId)).toBeDefined());
  return channel.response(id, "end", transactionId);
}

describe("Core private plugin artifact parent paths", () => {
  it("keeps the original begin request core-only and covers exact parent paths including missing descendants", async () => {
    const { root, channel } = await fixture();
    const existing = path.join(root, "existing.txt");
    const missing = path.join(root, "not-created", "child.txt");
    await writeFile(existing, "protected bytes");

    channel.request("begin", ID);
    await vi.waitFor(() => expect(channel.response(ID, "begin")).toBeDefined());
    expect(channel.response(ID, "begin")).toMatchObject({ ok: true,
      snapshot: { coverage: "core-only", references: [], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await end(channel)).toMatchObject({ ok: true });

    const paths = [parentPath(existing), parentPath(missing, "file", "missing-child")];
    const result = await begin(channel, paths, ID_3, TX_2);
    expect(result).toMatchObject({ ok: true, snapshot: {
      coverage: "core-and-parent-paths",
      references: [],
      parentPaths: paths.map(reference => ({ ...reference,
        canonicalPath: path.resolve(reference.path) })),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    expect(result.snapshot.fingerprint).not.toBe(channel.response(ID, "begin").snapshot.fingerprint);
    expect(await readFile(existing, "utf8")).toBe("protected bytes");

    expect(await end(channel, ID_4, TX_2)).toMatchObject({ ok: true });
    const changedMetadata = await begin(channel, [{ ...paths[0]!, state: "retained" }, paths[1]!],
      "77777777-7777-4777-8777-777777777777",
      "77777777-7777-4777-8777-777777777777");
    expect(changedMetadata.ok).toBe(true);
    expect(changedMetadata.snapshot.fingerprint).not.toBe(result.snapshot.fingerprint);
    expect(await end(channel, "88888888-8888-4888-8888-888888888888", "77777777-7777-4777-8777-777777777777"))
      .toMatchObject({ ok: true });

    const fresh = await begin(channel, paths, "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(fresh.ok).toBe(true);
    await mkdir(path.dirname(missing));
    await writeFile(missing, "new child");
    channel.request("check", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await vi.waitFor(() => expect(channel.response("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "check",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBeDefined());
    expect(channel.response("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "check",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toMatchObject({ ok: false, errorCode: FAILURE });
    expect(await end(channel, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .toMatchObject({ ok: false, errorCode: FAILURE });
  });

  it.each(["replacement", "content change"] as const)("rejects a parent file %s on check and end", async change => {
    const { root, channel } = await fixture();
    const file = path.join(root, "artifact.txt");
    await writeFile(file, "initial");
    expect((await begin(channel, [parentPath(file)])).ok).toBe(true);

    if (change === "replacement") {
      const replacement = path.join(root, "replacement.txt");
      await writeFile(replacement, "initial");
      await rm(file);
      await rename(replacement, file);
    } else await writeFile(file, "changed size and content");

    channel.request("check", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "check")).toBeDefined());
    expect(channel.response(ID_2, "check")).toMatchObject({ ok: false, errorCode: FAILURE });
    expect(await end(channel, ID_3)).toMatchObject({ ok: false, errorCode: FAILURE });
  });

  it("rejects a linked parent directory on check and end", async () => {
    const { root, channel } = await fixture();
    const parent = path.join(root, "parent");
    const relocated = path.join(root, "relocated");
    const file = path.join(parent, "artifact.txt");
    await mkdir(parent);
    await writeFile(file, "protected");
    expect((await begin(channel, [parentPath(file)])).ok).toBe(true);

    await rename(parent, relocated);
    await symlink(relocated, parent, process.platform === "win32" ? "junction" : "dir");
    channel.request("check", ID_2);
    await vi.waitFor(() => expect(channel.response(ID_2, "check")).toBeDefined());
    expect(channel.response(ID_2, "check")).toMatchObject({ ok: false, errorCode: FAILURE });
    expect(await end(channel, ID_3)).toMatchObject({ ok: false, errorCode: FAILURE });

    const secondParent = path.join(root, "second-parent");
    const secondRelocated = path.join(root, "second-relocated");
    const secondFile = path.join(secondParent, "artifact.txt");
    await mkdir(secondParent);
    await writeFile(secondFile, "protected");
    expect((await begin(channel, [parentPath(secondFile)], "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888")).ok).toBe(true);
    await rename(secondParent, secondRelocated);
    await symlink(secondRelocated, secondParent, process.platform === "win32" ? "junction" : "dir");
    expect(await end(channel, "99999999-9999-4999-8999-999999999999", "88888888-8888-4888-8888-888888888888"))
      .toMatchObject({ ok: false, errorCode: FAILURE });
  });

  it("accepts an empty parentPaths array as parent-path coverage", async () => {
    const { channel } = await fixture();
    const result = await begin(channel, []);
    expect(result).toMatchObject({ ok: true,
      snapshot: { coverage: "core-and-parent-paths", references: [], parentPaths: [],
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(await end(channel)).toMatchObject({ ok: true });
  });

  it.each([
    ["malformed fields", [{ source: "x", ownerId: "x", state: "x", path: "relative", kind: "file" }]],
    ["non-plain values", [{ source: "x", ownerId: "x", state: "x", path: "", kind: "file" }]],
    ["duplicate tuples", [parentPath("C:\\duplicate.txt", "file", "same"), parentPath("C:\\duplicate.txt", "file", "same")]],
    ["more than the limit", Array.from({ length: MAX_PARENT_PATHS + 1 }, (_, index) =>
      parentPath("C:\\parent-" + index + ".txt", "file", "owner-" + index))],
  ])("denies begin with %s before capturing a Core snapshot", async (_label, parentPaths) => {
    const { channel, maintenance, listPlugins } = await fixture();
    const result = await begin(channel, parentPaths as ParentPath[]);
    expect(result).toMatchObject({ ok: false, errorCode: FAILURE });
    expect(channel.messages.some(message => message.kind === RESPONSE && message.ok === true)).toBe(false);
    expect(listPlugins).not.toHaveBeenCalled();
    await maintenance.withActivity(async () => {});
  });

  it.each(["check", "end"] as const)("denies parentPaths on %s", async operation => {
    const { channel, maintenance } = await fixture();
    expect((await begin(channel, [])).ok).toBe(true);
    const invalidId = ID_2;
    channel.request(operation, invalidId, TX, { parentPaths: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(channel.messages.some(message => message.kind === RESPONSE && message.id === invalidId)).toBe(false);
    await expect(maintenance.withActivity(async () => {})).rejects.toMatchObject({ code: "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY" });
    expect(await end(channel, ID_3)).toMatchObject({ ok: false, errorCode: FAILURE });
  });
});
