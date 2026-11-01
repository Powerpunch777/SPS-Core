import { link, lstat, mkdir, mkdtemp, opendir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSpsPluginArtifactOwnership,
  parseSpsOwnedPluginArtifact,
} from "../services/sps-plugin-artifact-ownership.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const roots: Array<{ root: string; temp: string; dev: bigint; ino: bigint; birthtimeNs: bigint }> = [];
afterEach(async () => {
  vi.mocked(opendir).mockReset();
  for (const owned of roots.splice(0)) {
    const stats = await lstat(owned.root, { bigint: true });
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.temp
      && path.basename(owned.root).startsWith("sps-artifact-owner-")).toBe(true);
    expect(stats.isDirectory() && !stats.isSymbolicLink()).toBe(true);
    expect(await realpath(owned.root)).toBe(owned.root);
    expect([stats.dev, stats.ino, stats.birthtimeNs]).toEqual([owned.dev, owned.ino, owned.birthtimeNs]);
    await rm(owned.root, { recursive: true, force: true });
  }
});
const metadata = { pluginKey: "test.artifact", packageName: "@test/artifact", version: "1.0.0" };
const pluginId = "fca72de0-75ac-4be1-8ff5-4c8cfeaa6eef";
async function fixture() {
  const temp = await realpath(os.tmpdir());
  const owned = await mkdtemp(path.join(temp, "sps-artifact-owner-"));
  const stats = await lstat(owned, { bigint: true });
  roots.push({ root: owned, temp, dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs });
  const root = path.join(owned, "storage");
  await mkdir(root);
  return { root, store: createSpsPluginArtifactOwnership(root) };
}
async function populate(root: string) {
  await mkdir(path.join(root, "package"));
  await writeFile(path.join(root, "package", "manifest.js"), "throw Error('must not import');\n");
}

describe("Host-local Plugin artifact ownership", () => {
  it("lists missing ownership records without creating storage or record directories", async () => {
    const { root, store } = await fixture();
    const missing = path.join(root, "missing", "storage");
    expect(await createSpsPluginArtifactOwnership(missing).listAllocatedIds()).toEqual([]);
    await expect(lstat(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.listAllocatedIds()).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    await mkdir(path.join(root, ".artifact-ownership"));
    expect(await store.listAllocatedIds()).toEqual([]);
  });

  it("lists paired and allocation-only IDs once in sorted order without verifying artifact bytes", async () => {
    const { root, store } = await fixture();
    const complete = await store.allocate("install");
    await populate(complete.root);
    const witness = await store.seal(complete, metadata);
    const incomplete = await store.allocate("upgrade", pluginId);
    const incompleteId = path.basename(incomplete.root);
    const allocationFile = path.join(root, ".artifact-ownership", `${incompleteId}.allocation.json`);
    await writeFile(allocationFile, "{incomplete");
    await writeFile(path.join(complete.root, "package", "manifest.js"), "changed bytes\n");
    await rename(incomplete.root, `${incomplete.root}.preserved`);
    expect(await store.listAllocatedIds()).toEqual([witness.allocation.id, incompleteId].sort());
    expect(await createSpsPluginArtifactOwnership(root).listAllocatedIds()).toEqual([witness.allocation.id, incompleteId].sort());
    expect(await readFile(allocationFile, "utf8")).toBe("{incomplete");
    expect(await readFile(path.join(complete.root, "package", "manifest.js"), "utf8")).toBe("changed bytes\n");
    await expect(store.read(incompleteId)).rejects.toThrow();
  });

  it("rejects verified records without their allocation record", async () => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    await populate(ticket.root);
    const witness = await store.seal(ticket, metadata);
    await rm(path.join(root, ".artifact-ownership", `${witness.allocation.id}.allocation.json`));
    await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
  });

  it.each(["notes.txt", "invalid.allocation.json", `${pluginId}.allocation.json.extra`, `${pluginId.toUpperCase()}.allocation.json`])(
    "rejects unknown or noncanonical record filename %s", async name => {
      const { root, store } = await fixture();
      const records = path.join(root, ".artifact-ownership");
      await mkdir(records);
      await writeFile(path.join(records, name), "keep");
      await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
      expect(await readFile(path.join(records, name), "utf8")).toBe("keep");
    },
  );

  it.each(["directory", "junction", "hardlink"])("rejects a record that is a %s", async kind => {
    const { root, store } = await fixture();
    const records = path.join(root, ".artifact-ownership");
    await mkdir(records);
    const record = path.join(records, `${pluginId}.allocation.json`);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const sentinel = path.join(outside, "keep.txt");
    await writeFile(sentinel, "keep");
    if (kind === "directory") await mkdir(record);
    else if (kind === "junction") await symlink(outside, record, process.platform === "win32" ? "junction" : "dir");
    else await link(sentinel, record);
    await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it.each(["storage", "records"])("rejects a linked %s ancestry without creating or adopting records", async kind => {
    const { root, store } = await fixture();
    const records = path.join(root, ".artifact-ownership");
    await mkdir(records);
    const source = kind === "storage" ? root : records;
    const preserved = `${source}.preserved`;
    await rename(source, preserved);
    await symlink(preserved, source, process.platform === "win32" ? "junction" : "dir");
    await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
    expect(await readdir(kind === "storage" ? path.join(preserved, ".artifact-ownership") : preserved)).toEqual([]);
  });

  it.each(["storage", "records", "membership"])("rejects changed %s during enumeration", async kind => {
    const { root, store } = await fixture();
    const ticket = await store.allocate("install");
    const id = path.basename(ticket.root);
    const records = path.join(root, ".artifact-ownership");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(opendir).mockImplementationOnce(actual.opendir).mockImplementationOnce(async directoryPath => {
      if (kind === "storage") {
        await rename(root, `${root}.preserved`);
        await mkdir(root);
        await rename(path.join(`${root}.preserved`, ".artifact-ownership"), records);
      } else if (kind === "records") {
        await rename(records, `${records}.preserved`);
        await mkdir(records);
        await rename(path.join(`${records}.preserved`, `${id}.allocation.json`), path.join(records, `${id}.allocation.json`));
      } else await writeFile(path.join(records, `${pluginId}.allocation.json`), "{incomplete");
      return actual.opendir(directoryPath);
    });
    await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
    expect(await readFile(path.join(records, `${id}.allocation.json`), "utf8")).toContain(id);
  });

  it("bounds streamed entry count without silently truncating the allocation list", async () => {
    const { root, store } = await fixture();
    await store.allocate("install");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let emitted = 0;
    vi.mocked(opendir).mockImplementationOnce(async directoryPath => {
      const directory = await actual.opendir(directoryPath);
      const entry = (await directory.read())!;
      // Exercise the bound without creating 60,001 files; the directory handle is real and owned.
      directory[Symbol.asyncIterator] = async function* () {
        try {
          for (let i = 0; i <= 60_000; i++) {
            entry.name = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}.allocation.json`;
            emitted++;
            yield entry;
          }
        } finally { await directory.close(); }
      };
      return directory;
    });
    await expect(store.listAllocatedIds()).rejects.toThrow("ownership");
    expect(emitted).toBe(60_001);
    expect((await readdir(path.join(root, ".artifact-ownership"))).length).toBe(1);
  });

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
