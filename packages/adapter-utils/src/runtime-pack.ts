import fs from "node:fs/promises";
import path from "node:path";

const RUNTIME_PACK_MANIFEST = "sps-agent-runtime-pack.json";

export interface AgentRuntimePackManifest {
  format: number;
  id: string;
  version: string;
  commands?: Record<string, string>;
}

export interface InstalledAgentRuntimePack {
  root: string;
  manifest: AgentRuntimePackManifest;
}

function configuredRuntimePacksRoot(): string | null {
  const value = process.env.PAPERCLIP_AGENT_RUNTIME_PACKS_DIR?.trim();
  return value ? path.resolve(value) : null;
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = path.normalize(value);
  return !path.isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.+-]/).map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return left.localeCompare(right);
}

async function readManifest(root: string): Promise<InstalledAgentRuntimePack | null> {
  try {
    const raw = await fs.readFile(path.join(root, RUNTIME_PACK_MANIFEST), "utf8");
    const manifest = JSON.parse(raw) as AgentRuntimePackManifest;
    if (!Number.isInteger(manifest.format) || manifest.format < 1) return null;
    if (typeof manifest.id !== "string" || !manifest.id.trim()) return null;
    if (typeof manifest.version !== "string" || !manifest.version.trim()) return null;
    if (manifest.commands && typeof manifest.commands !== "object") return null;
    return { root, manifest };
  } catch {
    return null;
  }
}

/**
 * Enumerate explicit Agent Runtime packs installed beside a Core runtime.
 * The directory is owned by the host product; Core only understands the
 * manifest and never downloads or installs a provider on its own.
 */
export async function listInstalledAgentRuntimePacks(
  root = configuredRuntimePacksRoot(),
): Promise<InstalledAgentRuntimePack[]> {
  if (!root) return [];
  let idEntries: import("node:fs").Dirent[];
  try {
    idEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packs: InstalledAgentRuntimePack[] = [];
  for (const idEntry of idEntries) {
    if (!idEntry.isDirectory()) continue;
    const idRoot = path.join(root, idEntry.name);
    const direct = await readManifest(idRoot);
    if (direct) {
      packs.push(direct);
      continue;
    }
    let versions: import("node:fs").Dirent[];
    try {
      versions = await fs.readdir(idRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      const candidate = await readManifest(path.join(idRoot, version.name));
      if (candidate) packs.push(candidate);
    }
  }
  return packs;
}

/**
 * Resolve a command supplied by the newest valid, explicitly installed pack.
 * A pack command must remain inside that pack's root, preventing a malformed
 * manifest from turning this discovery hook into an arbitrary command source.
 */
export async function findAgentRuntimePackCommand(
  command: string,
  root = configuredRuntimePacksRoot(),
): Promise<string | null> {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) return null;
  const packs = await listInstalledAgentRuntimePacks(root);
  const candidates = packs
    .filter((pack) => isSafeRelativePath(pack.manifest.commands?.[normalizedCommand]))
    .sort((left, right) => compareVersions(right.manifest.version, left.manifest.version));

  for (const pack of candidates) {
    const relativeCommand = pack.manifest.commands?.[normalizedCommand];
    if (!relativeCommand || !isSafeRelativePath(relativeCommand)) continue;
    const resolved = path.resolve(pack.root, relativeCommand);
    const relative = path.relative(pack.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      // A partially copied pack is not executable. Continue to the next
      // compatible version instead of treating it as installed.
    }
  }
  return null;
}
