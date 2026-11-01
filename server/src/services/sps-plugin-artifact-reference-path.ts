import { promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";

type Kind = "file" | "directory";
type CapturedPath = { absolute: string; kind: Kind; stats: BigIntStats | null };
const identityFields = ["dev", "ino", "birthtimeNs"] as const;
const fileFields = [...identityFields, "size", "nlink", "mtimeNs", "ctimeNs"] as const;
const unavailable = () => new Error("Plugin artifact reference path is unavailable or changed; preserve its files.");
const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
  identityFields.every(key => left[key] === right[key]);

function assertPlainAbsolute(absolute: string): void {
  if (typeof absolute !== "string" || !absolute || absolute.length > 32_768
    || /[\u0000-\u001f\u007f]/.test(absolute) || !path.isAbsolute(absolute)
    || path.resolve(absolute) !== absolute) throw unavailable();
  const root = path.parse(absolute).root;
  // Only native local roots; UNC, device namespaces and drive-relative paths
  // are not plain paths for this private observation helper.
  if (process.platform === "win32" ? !/^[A-Za-z]:\\$/.test(root) : root !== "/") throw unavailable();
  const segments = absolute.slice(root.length).split(path.sep);
  if (segments.length > 1024 || segments.some(segment => segment === "." || segment === ".."
    || /[. ]$/.test(segment) || /[:\\/]/.test(segment)
    || process.platform === "win32" && (/[<>"|?*]/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment)))) throw unavailable();
}

async function lstat(absolute: string): Promise<BigIntStats | null> {
  try { return await fs.lstat(absolute, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertKind(stats: BigIntStats, kind: Kind, allowFileHardlinks: boolean): void {
  if (stats.isSymbolicLink() || (kind === "directory" ? !stats.isDirectory()
    : !stats.isFile() || stats.nlink < 1n || !allowFileHardlinks && stats.nlink !== 1n)) {
    throw unavailable();
  }
}

async function captureAncestry(absolute: string, kind: Kind, allowFileHardlinks: boolean): Promise<CapturedPath[]> {
  const captured: CapturedPath[] = [];
  for (let current = absolute;; current = path.dirname(current)) {
    const expected = current === absolute ? kind : "directory";
    const stats = await lstat(current);
    if (stats) assertKind(stats, expected, allowFileHardlinks);
    captured.push({ absolute: current, kind: expected, stats });
    if (path.dirname(current) === current) {
      if (!stats || !stats.isDirectory()) throw unavailable();
      break;
    }
  }
  return captured;
}

async function recheck(captured: CapturedPath[], allowFileHardlinks: boolean): Promise<void> {
  for (const original of captured) {
    const current = await lstat(original.absolute);
    if (!original.stats) {
      if (current) throw unavailable();
    } else {
      if (!current) throw unavailable();
      assertKind(current, original.kind, allowFileHardlinks);
      const fields = original.kind === "file" ? fileFields : identityFields;
      if (!fields.every(key => original.stats![key] === current[key])) throw unavailable();
    }
  }
}

/** Private reference observation, not managed-root containment, ownership,
 * deletion authority, cross-process exclusion or an OS sandbox. Never expose
 * canonicalPath in public diagnostics. Missing descendants remain protected. */
export async function captureSpsPluginArtifactReferencePath(
  absolute: string,
  kind: Kind,
  options: Readonly<{ allowFileHardlinks?: boolean }> = {},
): Promise<Readonly<{ canonicalPath: string; assertCurrent(): Promise<void> }>> {
  try {
    assertPlainAbsolute(absolute);
    if (kind !== "file" && kind !== "directory") throw unavailable();
    const allowFileHardlinks = options.allowFileHardlinks === true;
    const original = await captureAncestry(absolute, kind, allowFileHardlinks);
    const existing = original.find(entry => entry.stats)!;
    const canonicalExisting = await fs.realpath(existing.absolute);
    const suffix = path.relative(existing.absolute, absolute);
    const canonicalPath = path.resolve(canonicalExisting, suffix);
    assertPlainAbsolute(canonicalPath);
    const canonical = await captureAncestry(canonicalPath, kind, allowFileHardlinks);
    const resolved = canonical.find(entry => entry.absolute === canonicalExisting);
    if (!resolved?.stats || !sameIdentity(existing.stats!, resolved.stats)) throw unavailable();
    const assertCurrent = async (): Promise<void> => {
      try {
        await recheck(original, allowFileHardlinks);
        await recheck(canonical, allowFileHardlinks);
        if (await fs.realpath(existing.absolute) !== canonicalExisting) throw unavailable();
      } catch { throw unavailable(); }
    };
    await assertCurrent();
    return Object.freeze({ canonicalPath, assertCurrent });
  } catch { throw unavailable(); }
}
