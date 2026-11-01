import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v3";
import {
  captureSpsPluginArtifactInventory,
  parseSpsPluginArtifactInventory,
  type SpsPluginArtifactInventory,
} from "./sps-plugin-artifact-inventory.js";

const identitySchema = z.object({
  dev: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  ino: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  birthtimeNs: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
}).strict();
const allocationSchema = z.object({
  format: z.literal(1), id: z.string().uuid(), kind: z.enum(["install", "upgrade"]),
  relativeRoot: z.string(), pluginRecordId: z.string().uuid().nullable(), storageIdentity: identitySchema, rootIdentity: identitySchema,
  allocatedAt: z.string().datetime(),
}).strict();
const packageSchema = z.object({
  pluginKey: z.string().min(1).max(256), packageName: z.string().min(1).max(256),
  version: z.string().min(1).max(128),
}).strict();
const verifiedSchema = z.object({
  format: z.literal(1), allocation: allocationSchema, package: packageSchema,
  inventory: z.unknown(), verifiedAt: z.string().datetime(),
}).strict();
type AllocationRecord = z.infer<typeof allocationSchema>;
export type SpsOwnedPluginArtifact = {
  format: 1;
  allocation: AllocationRecord;
  package: z.infer<typeof packageSchema>;
  inventory: SpsPluginArtifactInventory;
  verifiedAt: string;
};
export type SpsPluginArtifactAllocation = Readonly<{ root: string }>;
const unavailable = () => new Error("Plugin artifact ownership is unavailable; preserve its files.");
const MAX_RECORD_ENTRIES = 60_000;
const recordName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(allocation|verified)\.json$/;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const identity = (stats: { dev: bigint; ino: bigint; birthtimeNs: bigint }) => ({
  dev: String(stats.dev), ino: String(stats.ino), birthtimeNs: String(stats.birthtimeNs),
});

async function directoryIdentity(absolute: string) {
  if (!path.isAbsolute(absolute) || path.resolve(absolute) !== absolute || absolute.includes("\0")) throw unavailable();
  let current = absolute;
  let own;
  for (;;) {
    const stats = await lstat(current, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw unavailable();
    if (current === absolute) own = identity(stats);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (await realpath(absolute) !== absolute || !own) throw unavailable();
  return own;
}

async function readPrivateJson(file: string): Promise<unknown> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 32n * 1024n * 1024n) throw unavailable();
  const handle = await open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!equal(identity(opened), identity(before)) || opened.size !== before.size) throw unavailable();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
      || !equal(identity(named), identity(before)) || !equal(identity(after), identity(before))
      || after.size !== before.size || named.size !== before.size
      || after.mtimeNs !== before.mtimeNs || named.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs || named.ctimeNs !== before.ctimeNs) throw unavailable();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

async function writeExclusiveJson(file: string, data: unknown): Promise<void> {
  const bytes = `${JSON.stringify(data)}\n`;
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  if (!equal(await readPrivateJson(file), data)) throw unavailable();
}

function validateAllocation(value: unknown): AllocationRecord {
  const record = allocationSchema.parse(value);
  if ((record.kind === "install") !== (record.pluginRecordId === null)) throw unavailable();
  const expected = record.kind === "install"
    ? `.install-staging/${record.id}` : `.upgrade-staging/${record.pluginRecordId}/${record.id}`;
  if (record.relativeRoot !== expected) throw unavailable();
  return record;
}

export function parseSpsOwnedPluginArtifact(value: unknown): SpsOwnedPluginArtifact {
  const parsed = verifiedSchema.parse(value);
  const allocation = validateAllocation(parsed.allocation);
  const inventory = parseSpsPluginArtifactInventory(parsed.inventory);
  if (!equal(allocation.rootIdentity, inventory.rootIdentity)) throw unavailable();
  return { ...parsed, allocation, inventory };
}

/** Host-local allocation provenance, never execution approval or a delete permit. */
export function createSpsPluginArtifactOwnership(storageRoot: string) {
  const root = path.resolve(storageRoot);
  const recordsRoot = path.join(root, ".artifact-ownership");
  const live = new WeakMap<SpsPluginArtifactAllocation, AllocationRecord>();

  async function prepare() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const storageIdentity = await directoryIdentity(root);
    await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
    await directoryIdentity(recordsRoot);
    return storageIdentity;
  }

  async function assertRecord(record: AllocationRecord) {
    if (!equal(await directoryIdentity(root), record.storageIdentity)) throw unavailable();
    await directoryIdentity(recordsRoot);
    const artifactRoot = path.join(root, ...record.relativeRoot.split("/"));
    if (!equal(await directoryIdentity(artifactRoot), record.rootIdentity)) throw unavailable();
    const persisted = validateAllocation(await readPrivateJson(path.join(recordsRoot, `${record.id}.allocation.json`)));
    if (!equal(persisted, record)) throw unavailable();
    return artifactRoot;
  }

  return {
    /** Record IDs only, including incomplete allocations; NOT byte verification or deletion authority. */
    async listAllocatedIds(): Promise<string[]> {
      let before: BigIntStats;
      try { before = await lstat(recordsRoot, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const storageIdentity = await directoryIdentity(root);
      const recordsIdentity = await directoryIdentity(recordsRoot);
      if (!equal(identity(before), recordsIdentity)) throw unavailable();

      async function captureEntries() {
        const names = new Set<string>();
        const directory = await opendir(recordsRoot);
        for await (const entry of directory) {
          if (names.size >= MAX_RECORD_ENTRIES || names.has(entry.name)) throw unavailable();
          const match = recordName.exec(entry.name);
          if (!match || !z.string().uuid().safeParse(match[1]).success) throw unavailable();
          names.add(entry.name);
        }
        const entries = new Map<string, BigIntStats>();
        for (const name of names) {
          const stats = await lstat(path.join(recordsRoot, name), { bigint: true });
          if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n
            || stats.size > 32n * 1024n * 1024n) throw unavailable();
          entries.set(name, stats);
        }
        return entries;
      }

      const entries = await captureEntries();
      const afterEntries = await captureEntries();
      if (!equal(await directoryIdentity(root), storageIdentity)
        || !equal(await directoryIdentity(recordsRoot), recordsIdentity)) throw unavailable();
      const after = await lstat(recordsRoot, { bigint: true });
      const unchanged = (left: BigIntStats, right: BigIntStats) =>
        equal(identity(left), identity(right)) && left.size === right.size && left.nlink === right.nlink
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
      if (!after.isDirectory() || after.isSymbolicLink() || !unchanged(before, after)
        || entries.size !== afterEntries.size) throw unavailable();
      const allocated = new Set<string>();
      const verified = new Set<string>();
      for (const [name, stats] of entries) {
        const current = afterEntries.get(name);
        if (!current || !unchanged(stats, current)) throw unavailable();
        const match = recordName.exec(name)!;
        (match[2] === "allocation" ? allocated : verified).add(match[1]!);
      }
      for (const id of verified) if (!allocated.has(id)) throw unavailable();
      return [...allocated].sort();
    },

    async allocate(kind: "install" | "upgrade", pluginRecordId: string | null = null): Promise<SpsPluginArtifactAllocation> {
      if (kind !== "install" && kind !== "upgrade") throw unavailable();
      if ((kind === "install" && pluginRecordId !== null)
        || (kind === "upgrade" && !z.string().uuid().safeParse(pluginRecordId).success)) throw unavailable();
      const storageIdentity = await prepare();
      const parent = kind === "install" ? path.join(root, ".install-staging")
        : path.join(root, ".upgrade-staging", pluginRecordId!);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await directoryIdentity(parent);
      const id = randomUUID();
      const artifactRoot = path.join(parent, id);
      // Exclusive creation is the ownership event; existing directories are never adopted.
      await mkdir(artifactRoot, { mode: 0o700 });
      const record: AllocationRecord = { format: 1, id, kind,
        relativeRoot: kind === "install" ? `.install-staging/${id}` : `.upgrade-staging/${pluginRecordId}/${id}`,
        pluginRecordId, storageIdentity,
        rootIdentity: await directoryIdentity(artifactRoot), allocatedAt: new Date().toISOString() };
      await writeExclusiveJson(path.join(recordsRoot, `${id}.allocation.json`), record);
      await assertRecord(record);
      const ticket = Object.freeze({ root: artifactRoot });
      live.set(ticket, record);
      return ticket;
    },

    async seal(ticket: SpsPluginArtifactAllocation, metadata: z.infer<typeof packageSchema>): Promise<SpsOwnedPluginArtifact> {
      const record = live.get(ticket);
      if (!record) throw unavailable();
      const packageIdentity = packageSchema.parse(metadata);
      const artifactRoot = await assertRecord(record);
      const inventory = await captureSpsPluginArtifactInventory(artifactRoot);
      if (!equal(inventory.rootIdentity, record.rootIdentity)) throw unavailable();
      const verified: SpsOwnedPluginArtifact = { format: 1, allocation: record,
        package: packageIdentity, inventory, verifiedAt: new Date().toISOString() };
      await assertRecord(record);
      await writeExclusiveJson(path.join(recordsRoot, `${record.id}.verified.json`), verified);
      live.delete(ticket);
      return verified;
    },

    async read(id: string): Promise<SpsOwnedPluginArtifact> {
      if (!z.string().uuid().safeParse(id).success) throw unavailable();
      await directoryIdentity(root);
      await directoryIdentity(recordsRoot);
      const verified = parseSpsOwnedPluginArtifact(await readPrivateJson(path.join(recordsRoot, `${id}.verified.json`)));
      if (verified.allocation.id !== id) throw unavailable();
      await assertRecord(verified.allocation);
      return verified;
    },
  };
}
