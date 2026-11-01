import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSpsPluginArtifactOwnership,
  parseSpsOwnedPluginArtifact,
} from "../services/sps-plugin-artifact-ownership.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const metadata = { pluginKey: "test.artifact", packageName: "@test/artifact", version: "1.0.0" };
const pluginId = "fca72de0-75ac-4be1-8ff5-4c8cfeaa6eef";
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sps-artifact-owner-")));
  roots.push(root);
  return { root, store: createSpsPluginArtifactOwnership(root) };
}
async function populate(root: string) {
  await mkdir(path.join(root, "package"));
  await writeFile(path.join(root, "package", "manifest.js"), "throw Error('must not import');\n");
}

describe("Host-local Plugin artifact ownership", () => {
  it("persists exact newly allocated install bytes without importing executable metadata", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    expect(path.dirname(ticket.root)).toBe(path.join(root, ".install-staging"));
    await populate(ticket.root);
    const witness = await store.seal(ticket, metadata);
    expect(witness.package).toEqual(metadata);
    expect(witness.allocation.relativeRoot).toBe(`.install-staging/${witness.allocation.id}`);
    expect(witness.inventory.totalBytes).toBe(Buffer.byteLength("throw Error('must not import');\n"));
    expect(await createSpsPluginArtifactOwnership(root).read(witness.allocation.id)).toEqual(witness);
    expect(await readFile(path.join(ticket.root, "package", "manifest.js"), "utf8")).toContain("must not import");
    await expect(store.seal(ticket, metadata)).rejects.toThrow("ownership");
  });

  it("keeps existing upgrade paths and binds the registry UUID separately from the manifest key", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("upgrade", pluginId);
    expect(path.dirname(ticket.root)).toBe(path.join(root, ".upgrade-staging", pluginId));
    await populate(ticket.root);
    const witness = await store.seal(ticket, metadata);
    expect(witness.allocation.pluginRecordId).toBe(pluginId);
    expect(await store.read(witness.allocation.id)).toEqual(witness);
    await expect(store.allocate("upgrade", metadata.pluginKey)).rejects.toThrow("ownership");
    await expect(store.allocate("install", pluginId)).rejects.toThrow("ownership");
  });

  it("never adopts an old or caller-owned directory through a fabricated ticket", async () => {
    const { root, store } = await fixture();
    const external = path.join(root, "external-work");
    await mkdir(external);
    await populate(external);
    await expect(store.seal({ root: external }, metadata)).rejects.toThrow("ownership");
    expect(await readFile(path.join(external, "package", "manifest.js"), "utf8")).toContain("must not import");
  });

  it("does not transfer allocation authority between store instances or Host directories", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    await populate(ticket.root);
    await expect(createSpsPluginArtifactOwnership(root).seal(ticket, metadata)).rejects.toThrow("ownership");
    const witness = await store.seal(ticket, metadata);
    const foreign = await fixture();
    const records = path.join(foreign.root, ".artifact-ownership");
    await mkdir(records);
    for (const name of await readdir(path.join(root, ".artifact-ownership"))) {
      await writeFile(path.join(records, name), await readFile(path.join(root, ".artifact-ownership", name)));
    }
    await expect(foreign.store.read(witness.allocation.id)).rejects.toThrow("ownership");
    expect(await readFile(path.join(ticket.root, "package", "manifest.js"), "utf8")).toContain("must not import");
  });

  it("preserves a replaced allocation and does not mint a witness for it", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    await rename(ticket.root, `${ticket.root}.previous`);
    await mkdir(ticket.root);
    await populate(ticket.root);
    await expect(store.seal(ticket, metadata)).rejects.toThrow("ownership");
    expect((await readdir(path.join(root, ".artifact-ownership"))).every(name => name.endsWith(".allocation.json"))).toBe(true);
    expect(await readFile(path.join(ticket.root, "package", "manifest.js"), "utf8")).toContain("must not import");
  });

  it("preserves incomplete evidence and rejects links without treating either as deletion authority", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    const external = path.join(root, "work");
    await mkdir(external);
    await writeFile(path.join(external, "keep.txt"), "keep");
    await symlink(external, path.join(ticket.root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(store.seal(ticket, metadata)).rejects.toThrow();
    const id = path.basename(ticket.root);
    const evidence = path.join(root, ".artifact-ownership", `${id}.verified.json`);
    await writeFile(evidence, "{\"format\":");
    await expect(store.read(id)).rejects.toThrow();
    expect(await readFile(evidence, "utf8")).toBe("{\"format\":");
    expect(await readFile(path.join(external, "keep.txt"), "utf8")).toBe("keep");
  });

  it("rejects foreign fields, altered inventories and mismatched allocation paths", async () => {
    const { store } = await fixture();
    const ticket = await store.allocate("install");
    await populate(ticket.root);
    const witness = await store.seal(ticket, metadata);
    expect(() => parseSpsOwnedPluginArtifact({ ...witness, deleteAllowed: true })).toThrow();
    expect(() => parseSpsOwnedPluginArtifact({ ...witness, allocation: {
      ...witness.allocation, relativeRoot: "../work",
    } })).toThrow();
    expect(() => parseSpsOwnedPluginArtifact({ ...witness, inventory: {
      ...witness.inventory, totalBytes: witness.inventory.totalBytes + 1,
    } })).toThrow();
    await expect(store.read("../work")).rejects.toThrow("ownership");
  });
});
