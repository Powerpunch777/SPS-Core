import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { PluginRecord } from "../compat/paperclip/shared.js";

const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_CSS_FILES = 32;
const MAX_UI_DIRECTORY_ENTRIES = 256;
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
});

export type SpsNativePluginUiAsset = Readonly<{
  path: string;
  contentType: string;
  bytes: string;
  sha256: string;
}>;

type PluginUiPackage = Pick<PluginRecord, "packageName" | "packagePath" | "manifestJson">;

const unavailable = () => new Error("Native Plugin access is unavailable.");

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US") : a === b;
}

function safeSegments(value: unknown, maxLength: number): string[] {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength
    || value.startsWith("/") || value.startsWith("\\") || value.includes("\\") || value.includes("%")
    || /[\u0000-\u001f\u007f:?#]/.test(value)) throw unavailable();
  const segments = value.split("/");
  if (segments.length > 8 || segments.some(segment => !segment || segment === "." || segment === ".."
    || !/^[A-Za-z0-9._-]+$/.test(segment))) throw unavailable();
  return segments;
}

function packageRoot(localPluginDir: string, plugin: PluginUiPackage): string {
  if (typeof plugin.packagePath === "string" && plugin.packagePath.trim()) return path.resolve(plugin.packagePath);
  const packageName = plugin.packageName;
  if (typeof packageName !== "string" || !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) throw unavailable();
  const installed = path.resolve(localPluginDir, "node_modules", ...packageName.split("/"));
  if (!isInside(path.resolve(localPluginDir), installed)) throw unavailable();
  return installed;
}

async function existingPackageRoot(localPluginDir: string, plugin: PluginUiPackage): Promise<string> {
  let candidate = packageRoot(localPluginDir, plugin);
  try { await fs.lstat(candidate); }
  catch {
    if (plugin.packagePath) throw unavailable();
    const direct = path.resolve(localPluginDir, ...plugin.packageName.split("/"));
    if (!isInside(path.resolve(localPluginDir), direct)) throw unavailable();
    try { await fs.lstat(direct); candidate = direct; }
    catch { throw unavailable(); }
  }
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  const canonical = await fs.realpath(candidate);
  if (!path.isAbsolute(canonical)) throw unavailable();
  return canonical;
}

async function resolveUiRoot(localPluginDir: string, plugin: PluginUiPackage): Promise<{ packageRoot: string; uiRoot: string }> {
  const packagePath = await existingPackageRoot(localPluginDir, plugin);
  const entry = plugin.manifestJson?.entrypoints?.ui;
  const cleanedEntry = typeof entry === "string" ? entry.replace(/^\.\//, "").replace(/\/+$/, "") : entry;
  const entrySegments = safeSegments(cleanedEntry, 500);
  const lexicalUiRoot = path.resolve(packagePath, ...entrySegments);
  if (!isInside(packagePath, lexicalUiRoot)) throw unavailable();
  let current = packagePath;
  for (const segment of entrySegments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  const uiRoot = await fs.realpath(lexicalUiRoot);
  if (!isInside(packagePath, uiRoot)) throw unavailable();
  return { packageRoot: packagePath, uiRoot };
}

function sameStat(left: Awaited<ReturnType<typeof fs.stat>>, right: Awaited<ReturnType<typeof fs.stat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function directoryChain(root: string, target: string): Promise<Array<{ path: string; stat: Awaited<ReturnType<typeof fs.stat>> }>> {
  if (!isInside(root, target)) throw unavailable();
  const relative = path.relative(root, target);
  const paths = [root];
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    paths.push(current);
  }
  const result = [];
  for (const candidate of paths) {
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(candidate), candidate)) throw unavailable();
    result.push({ path: candidate, stat });
  }
  return result;
}

async function verifyDirectoryChain(chain: Array<{ path: string; stat: Awaited<ReturnType<typeof fs.stat>> }>): Promise<void> {
  for (const expected of chain) {
    const current = await fs.lstat(expected.path);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameStat(expected.stat, current)
      || !samePath(await fs.realpath(expected.path), expected.path)) throw unavailable();
  }
}

async function resolveFile(uiRoot: string, segments: string[]): Promise<{ lexical: string; real: string }> {
  let lexical = uiRoot;
  for (const [index, segment] of segments.entries()) {
    lexical = path.join(lexical, segment);
    const stat = await fs.lstat(lexical);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw unavailable();
  }
  const real = await fs.realpath(lexical);
  if (!isInside(uiRoot, real)) throw unavailable();
  return { lexical, real };
}

export function createSpsNativePluginUiAssetService(input: { localPluginDir: string }) {
  if (!input || typeof input.localPluginDir !== "string" || !path.isAbsolute(input.localPluginDir)) throw unavailable();
  const localPluginDir = path.resolve(input.localPluginDir);

  async function listCss(plugin: PluginUiPackage): Promise<readonly string[]> {
    const { packageRoot, uiRoot } = await resolveUiRoot(localPluginDir, plugin);
    const rootBefore = await directoryChain(path.parse(packageRoot).root, uiRoot);
    const directory = await fs.opendir(uiRoot);
    const files: string[] = [];
    let entriesSeen = 0;
    try {
      for await (const entry of directory) {
        if (++entriesSeen > MAX_UI_DIRECTORY_ENTRIES) throw unavailable();
        if (!entry.name.toLowerCase().endsWith(".css")) continue;
        if (entry.isSymbolicLink()) throw unavailable();
        if (!entry.isFile()) continue;
        const segments = safeSegments(entry.name, 200);
        if (segments.length !== 1) throw unavailable();
        files.push(entry.name);
        if (files.length > MAX_CSS_FILES) throw unavailable();
      }
    } finally {
      await directory.close().catch(() => {});
    }
    await verifyDirectoryChain(rootBefore);
    return Object.freeze(files.sort((a, b) => a.localeCompare(b)));
  }

  async function read(plugin: PluginUiPackage, relativePath: string): Promise<SpsNativePluginUiAsset> {
    const segments = safeSegments(relativePath, 200);
    const normalizedPath = segments.join("/");
    const contentType = MIME_TYPES[path.extname(segments.at(-1)!).toLowerCase()];
    if (!contentType) throw unavailable();
    const { packageRoot, uiRoot } = await resolveUiRoot(localPluginDir, plugin);
    const { lexical, real } = await resolveFile(uiRoot, segments);
    const rootBefore = await directoryChain(path.parse(packageRoot).root, uiRoot);
    const parentBefore = await directoryChain(uiRoot, path.dirname(lexical));
    await verifyDirectoryChain(rootBefore);
    await verifyDirectoryChain(parentBefore);
    const before = await fs.lstat(lexical);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_ASSET_BYTES) throw unavailable();
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await fs.open(real, fsConstants.O_RDONLY | noFollow);
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || !sameStat(before, openedBefore) || openedBefore.size > MAX_ASSET_BYTES) throw unavailable();
      const buffer = Buffer.allocUnsafe(MAX_ASSET_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > MAX_ASSET_BYTES) throw unavailable();
      const openedAfter = await handle.stat();
      const currentPath = await fs.lstat(lexical);
      const currentReal = await fs.realpath(lexical);
      await verifyDirectoryChain(rootBefore);
      await verifyDirectoryChain(parentBefore);
      if (offset !== openedBefore.size || !sameStat(openedBefore, openedAfter) || !sameStat(openedAfter, currentPath)
        || currentPath.isSymbolicLink() || !samePath(currentReal, real)) throw unavailable();
      const bytes = buffer.subarray(0, offset);
      return Object.freeze({ path: normalizedPath, contentType, bytes: bytes.toString("base64url"),
        sha256: createHash("sha256").update(bytes).digest("hex") });
    } finally { await handle.close(); }
  }

  return Object.freeze({ read, listCss });
}
