#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./dev-service-profile.ts";

type WorkspaceLinkMismatch = {
  workspaceDir: string;
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

const workspacePackagePaths = discoverWorkspacePackagePaths(repoRoot);
const workspaceDirs = Array.from(
  new Set(
    Array.from(workspacePackagePaths.values())
      .map((packagePath) => path.relative(repoRoot, packagePath))
      .filter((workspaceDir) => workspaceDir.length > 0),
  ),
).sort();

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function findWorkspaceLinkMismatches(
  workspaceDir: string,
  rootDir: string,
  workspacePackagePaths: Map<string, string>,
): WorkspaceLinkMismatch[] {
  const nodeModulesDir = path.join(rootDir, workspaceDir, "node_modules");
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const packageJson = readJsonFile(path.join(rootDir, workspaceDir, "package.json"));
  const dependencies = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;

    const linkPath = path.join(rootDir, workspaceDir, "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath && sameFilesystemPath(actualPath, expectedPath)) continue;

    mismatches.push({
      workspaceDir,
      packageName,
      expectedPath: path.resolve(expectedPath),
      actualPath,
    });
  }

  return mismatches;
}

export async function createWorkspacePackageLink(expectedPath: string, linkPath: string, nodeModulesDir: string) {
  const expectedStat = await fs.stat(expectedPath);
  if (!expectedStat.isDirectory()) throw new Error("Workspace package target is not a directory.");
  const expectedRealPath = realpathSync(expectedPath);

  const nodeModulesStat = await fs.lstat(nodeModulesDir);
  if (!nodeModulesStat.isDirectory() || nodeModulesStat.isSymbolicLink()) {
    throw new Error("Workspace node_modules directory is linked or invalid.");
  }

  const scopeDir = path.dirname(linkPath);
  if (!sameFilesystemPath(scopeDir, nodeModulesDir)) {
    try {
      const scopeStat = await fs.lstat(scopeDir);
      if (!scopeStat.isDirectory() || scopeStat.isSymbolicLink()) {
        throw new Error("Workspace package scope is linked or invalid.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      await fs.mkdir(scopeDir);
    }
  }

  try {
    await fs.lstat(linkPath);
    let currentRealPath: string;
    try {
      currentRealPath = realpathSync(linkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new Error("Workspace package link has a dangling target; preserving it.");
      }
      throw error;
    }
    if (sameFilesystemPath(currentRealPath, expectedRealPath)) return false;
    throw new Error("Workspace package path already exists with a different target; preserving it.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const target = process.platform === "win32"
    ? expectedRealPath
    : path.relative(path.dirname(linkPath), expectedRealPath);
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  return true;
}

export async function ensureWorkspaceLinksCurrent(
  workspaceDir: string,
  { rootDir = repoRoot, workspacePackagePaths = discoverWorkspacePackagePaths(rootDir) } = {},
) {
  const mismatches = findWorkspaceLinkMismatches(workspaceDir, rootDir, workspacePackagePaths);
  if (mismatches.length === 0) return;

  console.log(`[paperclip] detected stale workspace package links for ${workspaceDir}; relinking dependencies...`);
  for (const mismatch of mismatches) {
    console.log(
      `[paperclip]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}`,
    );
  }

  for (const mismatch of mismatches) {
    const nodeModulesDir = path.join(rootDir, mismatch.workspaceDir, "node_modules");
    const linkPath = path.join(nodeModulesDir, ...mismatch.packageName.split("/"));
    await createWorkspacePackageLink(mismatch.expectedPath, linkPath, nodeModulesDir);
  }

  const remainingMismatches = findWorkspaceLinkMismatches(workspaceDir, rootDir, workspacePackagePaths);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all ${workspaceDir} package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const workspaceDir of workspaceDirs) {
    await ensureWorkspaceLinksCurrent(workspaceDir, { rootDir: repoRoot, workspacePackagePaths });
  }
}
