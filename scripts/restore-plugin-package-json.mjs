#!/usr/bin/env node

import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const packageDir = process.cwd();
const packageJsonPath = join(packageDir, "package.json");
const devPackageJsonPath = join(packageDir, "package.dev.json");

if (existsSync(devPackageJsonPath)) {
  rmSync(packageJsonPath, { force: true });
  renameSync(devPackageJsonPath, packageJsonPath);
}
