import { promises as fs, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function resolveNativePackageName(): string | null {
  if (process.platform !== "linux") return null;

  switch (process.arch) {
    case "arm64":
      return "linux-arm64";
    case "arm":
      return "linux-arm";
    case "ia32":
      return "linux-ia32";
    case "ppc64":
      return "linux-ppc64";
    case "x64":
      return "linux-x64";
    default:
      return null;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.stat(value);
    return true;
  } catch {
    return false;
  }
}

function resolveEmbeddedPostgresPackageRoot(): string | null {
  try {
    const entry = require.resolve("embedded-postgres");
    return path.dirname(path.dirname(entry));
  } catch {
    return null;
  }
}

function prependPathEnv(name: string, value: string): void {
  const current = process.env[name] ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) return;
  process.env[name] = [value, ...parts].join(path.delimiter);
}

function isAsciiPath(value: string): boolean {
  return /^[\x00-\x7f]+$/.test(value);
}

const WINDOWS_SUBST_CANDIDATES = ["S", "T", "U", "V", "W", "X", "Y", "Z"];
const createdWindowsSubstDrives = new Set<string>();
let windowsSubstCleanupRegistered = false;

/**
 * PostgreSQL's Windows bootstrap scripts can still parse the binary/share path
 * with the active ANSI code page. A source checkout under a Korean or other
 * Unicode folder then fails even when the database directory itself is ASCII.
 * Use an NTFS short path when it is available; packaged SPS installs normally
 * already use an ASCII Program Files path and do not need this branch.
 */
export function resolveWindowsShortPath(value: string): string | null {
  if (process.platform !== "win32" || isAsciiPath(value)) return null;

  try {
    const command = `for %I in ("${value.replaceAll('"', '""')}") do @echo %~sI`;
    const output = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return output && isAsciiPath(output) ? output : null;
  } catch {
    return null;
  }
}

function findWindowsUnicodePathRoot(value: string): string | null {
  const parsed = path.parse(value);
  const segments = value.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  let current = parsed.root;
  let unicodeRoot: string | null = null;

  for (const segment of segments) {
    current = path.join(current, segment);
    if (!isAsciiPath(segment)) unicodeRoot = current;
  }

  return unicodeRoot;
}

function registerWindowsSubstCleanup(): void {
  if (windowsSubstCleanupRegistered) return;
  windowsSubstCleanupRegistered = true;

  process.once("exit", cleanupWindowsSubstMappings);
}

/**
 * Releases only the temporary drive mappings created by this SPS process.
 * Desktop calls this before its Owner Host shuts down because Electron-as-Node
 * can terminate before a normal Node `exit` listener has a chance to finish.
 */
export function cleanupWindowsSubstMappings(): void {
  for (const drive of createdWindowsSubstDrives) {
    try {
      execFileSync("subst.exe", [drive, "/d"], { stdio: "ignore", windowsHide: true });
    } catch {
      // The mapping is a local compatibility aid. Cleanup failures leave no
      // project data behind and Windows clears mappings at sign-out.
    }
  }
  createdWindowsSubstDrives.clear();
}

function getWindowsSubstDrives(): Set<string> {
  try {
    const output = execFileSync("subst.exe", [], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return new Set([...output.matchAll(/^([A-Z]):\\:/gim)].map((match) => `${match[1]!.toUpperCase()}:`));
  } catch {
    return new Set();
  }
}

function windowsPathsMatch(left: string, right: string): boolean {
  const resolveComparablePath = (value: string): string => {
    try {
      return (realpathSync.native?.(value) ?? realpathSync(value)).replaceAll("/", "\\").toLowerCase();
    } catch {
      return path.resolve(value).replaceAll("/", "\\").toLowerCase();
    }
  };
  return resolveComparablePath(left) === resolveComparablePath(right);
}

function mappedWindowsPath(drive: string, unicodeRoot: string, value: string): string | null {
  const relative = path.relative(unicodeRoot, value);
  const mappedPath = relative ? `${drive}\\${relative}` : `${drive}\\`;
  return isAsciiPath(mappedPath) ? mappedPath : null;
}

/**
 * NTFS 8.3 aliases can be disabled on a volume, leaving a Unicode segment in
 * an otherwise short path. In that case, expose the smallest Unicode ancestor
 * through an unused ASCII drive letter for the lifetime of the SPS process.
 */
function resolveWindowsSubstPath(value: string): string | null {
  if (process.platform !== "win32") return null;

  const unicodeRoot = findWindowsUnicodePathRoot(value);
  if (!unicodeRoot) return null;

  const usedDrives = getWindowsSubstDrives();
  for (const candidate of WINDOWS_SUBST_CANDIDATES) {
    const drive = `${candidate}:`;
    if (usedDrives.has(drive) && windowsPathsMatch(`${drive}\\`, unicodeRoot)) {
      return mappedWindowsPath(drive, unicodeRoot, value);
    }
  }

  const drive = WINDOWS_SUBST_CANDIDATES.find((candidate) => !usedDrives.has(`${candidate}:`));
  if (!drive) return null;

  try {
    execFileSync("subst.exe", [`${drive}:`, unicodeRoot], { stdio: "ignore", windowsHide: true });
    const mappedPath = mappedWindowsPath(`${drive}:`, unicodeRoot, value);
    if (!mappedPath) return null;

    createdWindowsSubstDrives.add(`${drive}:`);
    registerWindowsSubstCleanup();
    return mappedPath;
  } catch {
    return null;
  }
}

export function resolveWindowsNativeRuntimePath(value: string): string | null {
  return resolveWindowsShortPath(value) ?? resolveWindowsSubstPath(value);
}

export async function ensureLinuxSharedLibraryAliases(libDir: string): Promise<string[]> {
  const entries = await fs.readdir(libDir, { withFileTypes: true });
  const created: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(/^(lib.+\.so\.\d+)\.\d+(?:\.\d+)?$/);
    if (!match) continue;

    const aliasName = match[1];
    const aliasPath = path.join(libDir, aliasName);
    try {
      await fs.symlink(entry.name, aliasPath);
      created.push(aliasPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }

  return created;
}

export async function prepareEmbeddedPostgresNativeRuntime(): Promise<void> {
  const packageRoot = resolveEmbeddedPostgresPackageRoot();
  if (!packageRoot) return;

  if (process.platform === "win32") {
    const nativeRoot = path.resolve(packageRoot, "..", "@embedded-postgres", "windows-x64", "native");
    const binDir = path.join(nativeRoot, "bin");
    const runtimeBinDir = resolveWindowsNativeRuntimePath(binDir);
    if (runtimeBinDir) {
      process.env.SPS_EMBEDDED_POSTGRES_BINARY_DIR = runtimeBinDir;
    }
    return;
  }

  const nativePackageName = resolveNativePackageName();
  if (!nativePackageName) return;

  const nativeRoot = path.resolve(packageRoot, "..", "@embedded-postgres", nativePackageName);
  const libDir = path.join(nativeRoot, "native", "lib");
  if (!(await pathExists(libDir))) return;

  prependPathEnv("LD_LIBRARY_PATH", libDir);
  await ensureLinuxSharedLibraryAliases(libDir);
}
