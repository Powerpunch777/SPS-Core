#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const uiDir = join(repoRoot, "ui");
const packageJsonPath = join(uiDir, "package.json");
const devPackageJsonPath = join(uiDir, "package.dev.json");

if (existsSync(devPackageJsonPath)) {
  throw new Error(`Refusing to overwrite existing ${devPackageJsonPath}`);
}

const packageJsonText = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonText);

const publishPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  license: packageJson.license,
  homepage: packageJson.homepage,
  bugs: packageJson.bugs,
  repository: packageJson.repository,
  type: packageJson.type,
  files: ["dist"],
  publishConfig: {
    access: "public",
  },
};

writeFileSync(devPackageJsonPath, packageJsonText);
writeFileSync(packageJsonPath, `${JSON.stringify(publishPackageJson, null, 2)}\n`);

console.log("  ✓ Generated publishable UI package.json");
