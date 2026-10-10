import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DIRECT_LEGACY_MODULES = [
  "/routes/authz.js",
  "/services/access.js",
  "/services/activity-log.js",
  "/services/heartbeat.js",
  "/services/index.js",
  "/services/plugin-worker-manager.js",
];

export function isSpsOwnedSource(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const name = path.posix.basename(normalized);

  if (name.includes(".test.") || name.includes(".spec.") || name.endsWith(".d.ts")) {
    return false;
  }

  if (/^server\/src\/(auth|adapters|routes|services)\/sps-[^/]+\.ts$/.test(normalized)) {
    return true;
  }
  if (/^ui\/src\/(components|pages)\/Sps[^/]+\.tsx$/.test(normalized)) {
    return true;
  }
  if (/^ui\/src\/api\/(sps[^/]+|workspace-[^/]+)\.ts$/.test(normalized)) {
    return true;
  }
  return /^ui\/src\/lib\/sps-[^/]+\.ts$/.test(normalized);
}

export function importedModuleSpecifiers(source) {
  const modules = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) modules.push(match[1]);
  return modules;
}

export function isDirectLegacyImport(specifier) {
  if (specifier.startsWith("@paperclipai/")) return true;
  const normalized = specifier.replaceAll("\\", "/");
  return DIRECT_LEGACY_MODULES.some((suffix) => normalized.endsWith(suffix));
}

async function sourceFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "dist" && entry.name !== "node_modules") stack.push(absolute);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files;
}

export async function findSpsCompatibilityViolations(root) {
  const violations = [];
  for (const absolute of await sourceFiles(root)) {
    const relative = path.relative(root, absolute);
    if (!isSpsOwnedSource(relative)) continue;
    const source = await readFile(absolute, "utf8");
    for (const specifier of importedModuleSpecifiers(source)) {
      if (isDirectLegacyImport(specifier)) {
        violations.push({ file: relative.replaceAll("\\", "/"), specifier });
      }
    }
  }
  return violations;
}

async function main() {
  const root = path.resolve(process.cwd());
  const violations = await findSpsCompatibilityViolations(root);
  if (violations.length === 0) {
    console.log("SPS compatibility boundary check passed.");
    return;
  }

  console.error("SPS-owned modules must use the explicit compat/paperclip facade:");
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.specifier}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
