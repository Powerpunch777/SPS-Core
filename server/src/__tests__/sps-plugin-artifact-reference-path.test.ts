import { promises as fs, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSpsPluginArtifactReferencePath as capture } from "../services/sps-plugin-artifact-reference-path.js";

const identities = ["dev", "ino", "birthtimeNs"] as const;
const ownedRoots: Array<{ root: string; parent: string; identity: BigIntStats; sentinel: string; links: string[] }> = [];
const message = "Plugin artifact reference path is unavailable or changed; preserve its files.";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const owned of ownedRoots.splice(0)) {
    expect(path.isAbsolute(owned.root) && path.dirname(owned.root) === owned.parent
      && path.basename(owned.root).startsWith("sps-reference-path-")).toBe(true);
    expect(await fs.realpath(owned.root)).toBe(owned.root);
    const current = await fs.lstat(owned.root, { bigint: true });
    expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
    for (const key of identities) expect(current[key]).toBe(owned.identity[key]);
    expect(await fs.readFile(owned.sentinel, "utf8")).toBe("external synthetic bytes");
    for (const link of owned.links) {
      expect(path.dirname(link)).toBe(owned.root);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      await fs.unlink(link);
    }
    await fs.rm(owned.root, { recursive: true, force: false });
  }
});

async function fixture() {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, "sps-reference-path-"));
  const identity = await fs.lstat(root, { bigint: true });
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  const sentinel = path.join(outside, "keep.txt");
  await fs.writeFile(sentinel, "external synthetic bytes");
  const owned = { root, parent, identity, sentinel, links: [] as string[] };
  ownedRoots.push(owned);
  const directory = path.join(root, "PackageRoot");
  await fs.mkdir(directory);
  const file = path.join(directory, "worker.mjs");
  await fs.writeFile(file, "throw new Error('must not import this package');\n");
  return { ...owned, directory, file, outside };
}

describe("Host-private artifact reference path observation", () => {
  it("captures an immutable plain directory and file without writes or package imports", async () => {
    const { directory, file } = await fixture();
    const mkdir = vi.spyOn(fs, "mkdir");
    const write = vi.spyOn(fs, "writeFile");
    const remove = vi.spyOn(fs, "rm");
    const open = vi.spyOn(fs, "open");
    for (const [absolute, kind] of [[directory, "directory"], [file, "file"]] as const) {
      const result = await capture(absolute, kind);
      expect(result.canonicalPath).toBe(await fs.realpath(absolute));
      expect(Object.keys(result)).toEqual(["canonicalPath", "assertCurrent"]);
      expect(Object.isFrozen(result)).toBe(true);
      await expect(result.assertCurrent()).resolves.toBeUndefined();
    }
    expect(mkdir).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(file, "utf8")).toContain("must not import");
  });

  it.each(["file", "directory"] as const)("keeps missing %s descendants without creating them", async kind => {
    const { directory } = await fixture();
    const missing = path.join(directory, "missing", "nested", "leaf");
    const result = await capture(missing, kind);
    expect(result.canonicalPath).toBe(missing);
    await result.assertCurrent();
    await expect(fs.lstat(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "directory"] as const)("rejects a missing %s leaf that appears after capture", async kind => {
    const { directory } = await fixture();
    const leaf = path.join(directory, "new-leaf");
    const result = await capture(leaf, kind);
    if (kind === "file") await fs.writeFile(leaf, "new");
    else await fs.mkdir(leaf);
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it("rejects a missing intermediate directory appearing even while its leaf is absent", async () => {
    const { directory } = await fixture();
    const result = await capture(path.join(directory, "new", "leaf"), "file");
    await fs.mkdir(path.join(directory, "new"));
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it.each(["file", "directory"] as const)("rejects an existing %s leaf replaced at the same name", async kind => {
    const { file, directory } = await fixture();
    const absolute = kind === "file" ? file : directory;
    const result = await capture(absolute, kind);
    await fs.rename(absolute, `${absolute}.preserved`);
    if (kind === "file") await fs.writeFile(absolute, "replacement");
    else await fs.mkdir(absolute);
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it("rejects changed file metadata even when the file identity is retained", async () => {
    const { file } = await fixture();
    const before = await fs.lstat(file, { bigint: true });
    const result = await capture(file, "file");
    await fs.appendFile(file, "changed\n");
    const after = await fs.lstat(file, { bigint: true });
    for (const key of identities) expect(after[key]).toBe(before[key]);
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it.each([false, true])("rejects replacement of a captured ancestor (missing leaf: %s)", async missing => {
    const { directory, file } = await fixture();
    const result = await capture(missing ? path.join(directory, "absent", "worker") : file, "file");
    await fs.rename(directory, `${directory}.preserved`);
    await fs.mkdir(directory);
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it("permits unrelated directory membership changes without claiming directory ownership", async () => {
    const { directory } = await fixture();
    const result = await capture(directory, "directory");
    await fs.writeFile(path.join(directory, "unrelated"), "data");
    await result.assertCurrent();
  });

  it("rejects mismatched leaf kinds and non-directory ancestors", async () => {
    const { directory, file } = await fixture();
    await expect(capture(directory, "file")).rejects.toThrow(message);
    await expect(capture(file, "directory")).rejects.toThrow(message);
    await expect(capture(path.join(file, "missing"), "file")).rejects.toThrow(message);
    await expect(capture(file, "other" as "file")).rejects.toThrow(message);
  });

  it("rejects a hardlinked file on initial capture and after capture", async () => {
    const { root, file } = await fixture();
    const result = await capture(file, "file");
    await fs.link(file, path.join(root, "hardlink"));
    await expect(capture(file, "file")).rejects.toThrow(message);
    await expect(result.assertCurrent()).rejects.toThrow(message);
  });

  it.each([false, true])("rejects a linked directory ancestor (dangling: %s) without touching its target", async dangling => {
    const { root, outside, sentinel, links } = await fixture();
    const linked = path.join(root, "linked");
    await fs.symlink(dangling ? path.join(root, "never-created") : outside, linked,
      process.platform === "win32" ? "junction" : "dir");
    links.push(linked);
    await expect(capture(linked, "directory")).rejects.toThrow(message);
    await expect(capture(path.join(linked, "absent", "leaf"), "file")).rejects.toThrow(message);
    expect(await fs.readFile(sentinel, "utf8")).toBe("external synthetic bytes");
  });

  it("rejects a captured ancestor replaced by a junction/link and later repointed", async () => {
    const { root, directory, file, outside, links } = await fixture();
    const result = await capture(file, "file");
    await fs.rename(directory, `${directory}.preserved`);
    const type = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(outside, directory, type);
    links.push(directory);
    await expect(result.assertCurrent()).rejects.toThrow(message);
    await fs.unlink(directory);
    await fs.symlink(`${directory}.preserved`, directory, type);
    await expect(result.assertCurrent()).rejects.toThrow(message);
    expect(path.dirname(directory)).toBe(root);
  });

  it.skipIf(process.platform !== "win32")("accepts actual Windows mixed-case directory/file aliases by identity, including missing suffixes", async () => {
    const { root, directory, file } = await fixture();
    const alias = path.join(root, "pAcKaGeRoOt");
    expect(await fs.realpath(alias)).toBe(directory);
    expect(await fs.realpath(alias)).not.toBe(alias);
    for (const [absolute, kind, expected] of [
      [alias, "directory", directory],
      [path.join(alias, "WORKER.MJS"), "file", file],
      [path.join(alias, "missing", "file"), "file", path.join(directory, "missing", "file")],
    ] as const) {
      const result = await capture(absolute, kind);
      expect(result.canonicalPath).toBe(expected);
      await result.assertCurrent();
    }
  });

  it("rejects malformed, foreign or unbounded paths before filesystem reads", async () => {
    const { directory } = await fixture();
    const root = path.parse(directory).root;
    const inputs: unknown[] = [undefined, null, 1, "", "relative", "C:relative", "file:///tmp/example", "x".repeat(32_769),
      `${directory}\0`, `${directory}\n`, `${directory}\u007f`, `${directory}${path.sep}..${path.sep}escape`,
      `${directory}${path.sep}.${path.sep}leaf`, `${directory}${path.sep}trailing.`, `${directory}${path.sep}trailing `,
      `${directory}${path.sep}a:b`, `${directory}${path.sep}${"a".concat(path.sep).repeat(1025)}leaf`,
      process.platform === "win32" ? "\\\\server\\share\\path" : "C:\\foreign\\path",
      process.platform === "win32" ? "\\\\?\\C:\\path" : "//foreign/path",
      `${root}${path.sep}double`];
    if (process.platform === "win32") inputs.push(...["NUL", "CON.txt", "lpt1.log", "COM\u00b9", "bad?name"]
      .map(name => path.join(directory, name)));
    const stat = vi.spyOn(fs, "lstat");
    for (const value of inputs) await expect(capture(value as string, "directory")).rejects.toThrow(message);
    expect(stat).not.toHaveBeenCalled();
  });

  it("fails closed on a genuinely missing native filesystem root", async () => {
    const { directory } = await fixture();
    const realLstat = fs.lstat.bind(fs);
    const nativeRoot = path.parse(directory).root;
    const missing = Object.assign(new Error("synthetic missing root"), { code: "ENOENT" });
    vi.spyOn(fs, "lstat").mockImplementation(((absolute: string, options: unknown) => {
      if (absolute === nativeRoot) return Promise.reject(missing);
      return realLstat(absolute, options as { bigint: true });
    }) as typeof fs.lstat);
    await expect(capture(directory, "directory")).rejects.toThrow(message);
  });

  it("detects an actual ancestor swap during initial realpath capture before returning a reference", async () => {
    const { directory } = await fixture();
    const realpath = fs.realpath.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "realpath").mockImplementation((async (absolute: string) => {
      if (absolute === directory && !swapped) {
        swapped = true;
        await fs.rename(directory, `${directory}.preserved`);
        await fs.mkdir(directory);
      }
      return realpath(absolute);
    }) as typeof fs.realpath);
    await expect(capture(directory, "directory")).rejects.toThrow(message);
    expect(swapped).toBe(true);
  });
});
