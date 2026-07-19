import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LocalCodexAccountOption {
  value: string;
  label: string;
}

const CODEX_ACCOUNT_DIRECTORY = /^\.codex(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function accountLabel(directoryName: string) {
  if (directoryName === ".codex") return "Default Codex account";
  const suffix = directoryName
    .replace(/^\.codex-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const label = suffix.replace(/\b\w/g, (character) => character.toUpperCase());
  return label ? `${label} Codex account` : "Codex account";
}

export function resolveCodexAccountHomeRoot(env: NodeJS.ProcessEnv = process.env) {
  return env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
}

export function normalizeCodexAccountDirectory(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const directoryName = value.trim();
  if (!CODEX_ACCOUNT_DIRECTORY.test(directoryName)) {
    throw new Error("codexAccount must be a local .codex or .codex-* profile directory name");
  }
  return directoryName;
}

export function listLocalCodexAccountOptions(homeRoot = resolveCodexAccountHomeRoot()): LocalCodexAccountOption[] {
  try {
    const options = fs
      .readdirSync(homeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && CODEX_ACCOUNT_DIRECTORY.test(entry.name))
      .filter((entry) => fs.existsSync(path.join(homeRoot, entry.name, "auth.json")))
      .map((entry) => ({ value: entry.name, label: accountLabel(entry.name) }))
      .sort((left, right) => (
        left.value === ".codex"
          ? -1
          : right.value === ".codex"
            ? 1
            : left.label.localeCompare(right.label)
      ));
    if (options.length > 0) return options;
  } catch {
    // The configuration form still needs a stable sign-in target when the
    // home directory is temporarily unreadable.
  }
  return [{ value: ".codex", label: "Default Codex account (sign in required)" }];
}

export function resolveSelectedCodexHome(
  value: unknown,
  homeRoot = resolveCodexAccountHomeRoot(),
): string | null {
  const directoryName = normalizeCodexAccountDirectory(value);
  if (!directoryName) return null;
  return path.join(homeRoot, directoryName);
}
