import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";

const MAX_ENTRIES = 60_000;
const MAX_BYTES = 3 * 1024 * 1024 * 1024;
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const identitySchema = z.object({ dev: decimal, ino: decimal, birthtimeNs: decimal }).strict();
const relativePath = z.string().min(1).max(4096).refine(value =>
  !/[\\\u0000-\u001f\u007f:]/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part)));
const entrySchema = z.object({
  path: relativePath,
  kind: z.enum(["file", "directory"]),
  identity: identitySchema,
  sizeBytes: z.number().int().min(0).max(MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
const inventorySchema = z.object({
  format: z.literal(1),
  rootIdentity: identitySchema,
  entries: z.array(entrySchema).min(1).max(MAX_ENTRIES),
  totalBytes: z.number().int().min(0).max(MAX_BYTES),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type SpsPluginArtifactInventory = z.infer<typeof inventorySchema>;
type Metadata = BigIntStats;
type CapturedPath = { absolute: string; metadata: Metadata };
const identityFields = ["dev", "ino", "birthtimeNs"] as const;
const stableFields = [...identityFields, "size", "mtimeNs", "ctimeNs", "nlink"] as const;
const failure = () => new Error("Plugin artifact inventory is unavailable or changed; preserve its files.");
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (stats: Metadata) => ({ dev: String(stats.dev), ino: String(stats.ino), birthtimeNs: String(stats.birthtimeNs) });
const same = (left: Metadata, right: Metadata, fields: readonly (typeof stableFields)[number][] = stableFields) =>
  fields.every(key => left[key] === right[key]);

async function captureAncestry(root: string): Promise<CapturedPath[]> {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0")) throw failure();
  const result: CapturedPath[] = [];
  let current = root;
  for (;;) {
    const metadata = await lstat(current, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure();
    result.push({ absolute: current, metadata });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await realpath(root) !== root) throw failure();
  return result;
}

async function recheck(paths: CapturedPath[], ancestry = false) {
  for (const original of paths) {
    const current = await lstat(original.absolute, { bigint: true });
    if (current.isSymbolicLink() || current.isDirectory() !== original.metadata.isDirectory()
      || current.isFile() !== original.metadata.isFile()
      || !same(current, original.metadata, ancestry ? identityFields : stableFields)) throw failure();
  }
}

function payload(value: Omit<SpsPluginArtifactInventory, "fingerprint">): string {
  return JSON.stringify({ format: value.format, rootIdentity: value.rootIdentity,
    entries: value.entries, totalBytes: value.totalBytes });
}

/** Code-free filesystem observation, NOT package ownership or deletion authority. */
export async function captureSpsPluginArtifactInventory(root: string): Promise<SpsPluginArtifactInventory> {
  const ancestry = await captureAncestry(root);
  const captured: CapturedPath[] = [];
  const entries: SpsPluginArtifactInventory["entries"] = [];
  let totalBytes = 0;
  async function visit(directory: string, parent = "") {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure();
    captured.push({ absolute: directory, metadata });
    const children = await readdir(directory);
    children.sort(compare);
    for (const name of children) {
      if (entries.length >= MAX_ENTRIES) throw failure();
      const relative = parent ? `${parent}/${name}` : name;
      if (!relativePath.safeParse(relative).success) throw failure();
      const absolute = path.join(directory, name);
      const before = await lstat(absolute, { bigint: true });
      if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) throw failure();
      if (before.isDirectory()) {
        entries.push({ path: relative, kind: "directory", identity: identity(before), sizeBytes: 0, sha256: null });
        await visit(absolute, relative);
        continue;
      }
      if (before.nlink !== 1n || before.size < 0n || before.size > BigInt(MAX_BYTES - totalBytes)) throw failure();
      const handle = await open(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let digest: string;
      try {
        if (!same(before, await handle.stat({ bigint: true }))) throw failure();
        const content = createHash("sha256");
        let read = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          read += chunk.length;
          if (read > Number(before.size)) throw failure();
          content.update(chunk);
        }
        if (read !== Number(before.size) || !same(before, await handle.stat({ bigint: true }))) throw failure();
        digest = content.digest("hex");
      } finally { await handle.close(); }
      const after = await lstat(absolute, { bigint: true });
      if (!same(before, after) || !after.isFile() || after.isSymbolicLink()) throw failure();
      captured.push({ absolute, metadata: after });
      totalBytes += Number(before.size);
      entries.push({ path: relative, kind: "file", identity: identity(before), sizeBytes: Number(before.size), sha256: digest });
    }
  }
  await visit(root);
  if (entries.length === 0) throw failure();
  await recheck(captured);
  await recheck(ancestry, true);
  entries.sort((left, right) => compare(left.path, right.path));
  const data = { format: 1 as const, rootIdentity: identity(ancestry[0]!.metadata), entries, totalBytes };
  return { ...data, fingerprint: hash(payload(data)) };
}

/** Validate the entire private observation; it must never become a delete permit. */
export function parseSpsPluginArtifactInventory(value: unknown): SpsPluginArtifactInventory {
  const parsed = inventorySchema.parse(value);
  let previous = "";
  let total = 0;
  const directories = new Set<string>();
  for (const entry of parsed.entries) {
    if (previous && compare(previous, entry.path) >= 0) throw failure();
    previous = entry.path;
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && !directories.has(parent)) throw failure();
    if (entry.kind === "directory") {
      if (entry.sizeBytes !== 0 || entry.sha256 !== null) throw failure();
      directories.add(entry.path);
    } else {
      if (entry.sha256 === null) throw failure();
      total += entry.sizeBytes;
    }
  }
  if (total !== parsed.totalBytes || hash(payload(parsed)) !== parsed.fingerprint) throw failure();
  return parsed;
}

/** A changed/missing/link tree is unverified, never silently accepted as empty. */
export async function verifySpsPluginArtifactInventory(root: string, input: unknown): Promise<void> {
  const expected = parseSpsPluginArtifactInventory(input);
  const current = await captureSpsPluginArtifactInventory(root);
  if (current.fingerprint !== expected.fingerprint) throw failure();
}
