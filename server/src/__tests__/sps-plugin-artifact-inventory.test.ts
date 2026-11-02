import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureSpsPluginArtifactInventory,
  parseSpsPluginArtifactInventory,
  verifySpsPluginArtifactInventory,
} from "../services/sps-plugin-artifact-inventory.js";

async function fixture(run: (root: string, artifact: string) => Promise<void>) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "sps-artifact-inventory-"));
  const identity = await lstat(root, { bigint: true });
  const artifact = path.join(root, "package");
  try {
    await mkdir(path.join(artifact, "dist", "empty"), { recursive: true });
    await writeFile(path.join(artifact, "package.json"), '{"name":"inert-package"}\n');
    await writeFile(path.join(artifact, "dist", "worker.js"), "throw new Error('never import this fixture');\n");
    await writeFile(path.join(root, "keep.txt"), "external synthetic data must remain unchanged");
    await run(root, artifact);
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("external synthetic data must remain unchanged");
  } finally {
    expect(path.dirname(root)).toBe(parent);
    expect(await realpath(root)).toBe(root);
    const current = await lstat(root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of ["dev", "ino", "birthtimeNs"] as const) expect(current[key]).toBe(identity[key]);
    await rm(root, { recursive: true, force: false });
  }
}

describe("read-only managed Plugin artifact observations", () => {
  it("records every byte and empty directory without importing code or modifying metadata", async () => fixture(async (_root, artifact) => {
    const before = await lstat(path.join(artifact, "dist", "worker.js"), { bigint: true });
    const observed = await captureSpsPluginArtifactInventory(artifact);
    expect(observed.entries.map(entry => [entry.path, entry.kind])).toEqual([
      ["dist", "directory"], ["dist/empty", "directory"], ["dist/worker.js", "file"], ["package.json", "file"],
    ]);
    const bytes = await readFile(path.join(artifact, "dist", "worker.js"));
    expect(observed.entries.find(entry => entry.path === "dist/worker.js")?.sha256)
      .toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(observed.totalBytes).toBe(bytes.length + Buffer.byteLength('{"name":"inert-package"}\n'));
    expect(observed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(parseSpsPluginArtifactInventory(JSON.parse(JSON.stringify(observed)))).toEqual(observed);
    await expect(verifySpsPluginArtifactInventory(artifact, observed)).resolves.toBeUndefined();
    const after = await lstat(path.join(artifact, "dist", "worker.js"), { bigint: true });
    for (const key of ["dev", "ino", "birthtimeNs", "size", "mtimeNs", "ctimeNs", "nlink"] as const)
      expect(after[key]).toBe(before[key]);
  }));

  it("detects same-size file changes and preserves the changed package", async () => fixture(async (_root, artifact) => {
    const observed = await captureSpsPluginArtifactInventory(artifact);
    const file = path.join(artifact, "package.json");
    const before = await readFile(file);
    const changed = Buffer.from(before);
    changed[0] = 0;
    await writeFile(file, changed);
    await expect(verifySpsPluginArtifactInventory(artifact, observed)).rejects.toThrow();
    expect(await readFile(file)).toEqual(changed);
  }));

  it("rejects added or missing files rather than interpreting them as unused data", async () => fixture(async (_root, artifact) => {
    const observed = await captureSpsPluginArtifactInventory(artifact);
    await writeFile(path.join(artifact, "user-work.txt"), "preserve unknown work");
    await expect(verifySpsPluginArtifactInventory(artifact, observed)).rejects.toThrow();
    expect(await readFile(path.join(artifact, "user-work.txt"), "utf8")).toBe("preserve unknown work");
    await rename(path.join(artifact, "package.json"), path.join(artifact, "renamed.json"));
    await expect(verifySpsPluginArtifactInventory(artifact, observed)).rejects.toThrow();
  }));

  it("rejects a replacement root even when all file bytes are copied", async () => fixture(async (root, artifact) => {
    const observed = await captureSpsPluginArtifactInventory(artifact);
    await rename(artifact, path.join(root, "original"));
    await mkdir(path.join(artifact, "dist", "empty"), { recursive: true });
    for (const relative of ["package.json", "dist/worker.js"])
      await writeFile(path.join(artifact, relative), await readFile(path.join(root, "original", relative)));
    await expect(verifySpsPluginArtifactInventory(artifact, observed)).rejects.toThrow();
  }));

  it("rejects a linked package root, ancestor and descendant without following them", async () => fixture(async (root, artifact) => {
    const alias = path.join(root, "linked");
    await symlink(artifact, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(captureSpsPluginArtifactInventory(alias)).rejects.toThrow();
    await expect(captureSpsPluginArtifactInventory(path.join(alias, "dist"))).rejects.toThrow();
    await symlink(path.join(root, "keep.txt"), path.join(artifact, "linked-file"));
    await expect(captureSpsPluginArtifactInventory(artifact)).rejects.toThrow();
  }));

  it("rejects a multiply linked file while preserving both names", async () => fixture(async (root, artifact) => {
    await link(path.join(root, "keep.txt"), path.join(artifact, "linked-data.txt"));
    await expect(captureSpsPluginArtifactInventory(artifact)).rejects.toThrow();
    expect(await readFile(path.join(artifact, "linked-data.txt"), "utf8")).toBe("external synthetic data must remain unchanged");
  }));

  it("rejects missing, relative, noncanonical and empty roots", async () => fixture(async (root, artifact) => {
    await mkdir(path.join(root, "empty"));
    for (const value of [".", "", `${artifact}${path.sep}..${path.sep}package`, path.join(root, "missing"), path.join(root, "empty")])
      await expect(captureSpsPluginArtifactInventory(value)).rejects.toThrow();
  }));

  it("rejects unknown fields, corrupt digests, totals and duplicate/reordered entries", async () => fixture(async (_root, artifact) => {
    const observed = await captureSpsPluginArtifactInventory(artifact);
    const clone = () => JSON.parse(JSON.stringify(observed));
    const extra = clone(); extra.note = "not part of the observation";
    const nestedExtra = clone(); nestedExtra.entries[0].note = "not part of the observation";
    const badDigest = clone(); badDigest.fingerprint = "0".repeat(64);
    const badTotal = clone(); badTotal.totalBytes += 1;
    const duplicate = clone(); duplicate.entries.push(duplicate.entries[0]);
    const reordered = clone(); reordered.entries.reverse();
    const traversal = clone(); traversal.entries[0].path = "../external";
    const noParent = clone(); noParent.entries = noParent.entries.filter((entry: { path: string }) => entry.path !== "dist");
    const badDirectory = clone(); badDirectory.entries[0].sha256 = "a".repeat(64);
    const badFile = clone(); badFile.entries.find((entry: { kind: string }) => entry.kind === "file").sha256 = null;
    for (const value of [extra, nestedExtra, badDigest, badTotal, duplicate, reordered, traversal, noParent, badDirectory, badFile])
      expect(() => parseSpsPluginArtifactInventory(value)).toThrow();
  }));
});
