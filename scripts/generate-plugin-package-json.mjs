#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = process.cwd();
const packageJsonPath = join(packageDir, "package.json");
const sdkPackageJsonPath = join(repoRoot, "packages", "plugins", "sdk", "package.json");

if (!existsSync(packageJsonPath)) {
  throw new Error(`No package.json found in plugin directory: ${packageDir}`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const sdkPackageJson = JSON.parse(readFileSync(sdkPackageJsonPath, "utf8"));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const readPluginMetadata = (key) => {
  if (!(key in packageJson)) return undefined;
  const value = packageJson[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Plugin package metadata at \"${key}\" must be an object.`);
  }
  return value;
};
const spsPlugin = readPluginMetadata("spsPlugin");
const legacyPlugin = readPluginMetadata("paperclipPlugin");
if (spsPlugin && legacyPlugin && canonicalJson(spsPlugin) !== canonicalJson(legacyPlugin)) {
  throw new Error('Plugin package metadata is ambiguous: "spsPlugin" and legacy compatibility key "paperclipPlugin" must be structurally identical.');
}
const pluginMetadata = spsPlugin ?? legacyPlugin;
const publishConfig = packageJson.publishConfig ?? {};
const dependencies = {
  ...(packageJson.dependencies ?? {}),
  "@paperclipai/plugin-sdk": sdkPackageJson.version,
};

const publishPackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  license: packageJson.license,
  homepage: packageJson.homepage,
  bugs: packageJson.bugs,
  repository: packageJson.repository,
  type: packageJson.type,
  exports: publishConfig.exports ?? packageJson.exports,
  main: publishConfig.main,
  types: publishConfig.types,
  publishConfig,
  files: packageJson.files,
  ...(pluginMetadata ? { spsPlugin: pluginMetadata } : {}),
  keywords: packageJson.keywords,
  dependencies,
};

writeFileSync(packageJsonPath, `${JSON.stringify(publishPackageJson, null, 2)}\n`);

console.log(`  ✓ Generated publishable plugin package.json for ${packageJson.name}`);
