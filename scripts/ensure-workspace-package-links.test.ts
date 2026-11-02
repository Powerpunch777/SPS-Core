import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createWorkspacePackageLink } from "./ensure-workspace-package-links.ts";

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "workspace-package-links-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(name: string) {
  const area = path.join(root, name);
  const nodeModulesDir = path.join(area, "node_modules");
  const packageDir = path.join(area, "packages", "shared");
  const linkPath = path.join(nodeModulesDir, "@paperclipai", "shared");
  mkdirSync(nodeModulesDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), "{}\n");
  return { area, nodeModulesDir, packageDir, linkPath };
}

function makeDirectoryLink(target: string, link: string) {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("creates an idempotent workspace package link with a Windows junction when needed", async () => {
  const { nodeModulesDir, packageDir, linkPath } = fixture("create");

  assert.equal(await createWorkspacePackageLink(packageDir, linkPath, nodeModulesDir), true);
  assert.equal(realpathSync(linkPath), realpathSync(packageDir));
  if (process.platform === "win32") {
    assert.ok(path.isAbsolute(readlinkSync(linkPath)));
  }
  assert.equal(await createWorkspacePackageLink(packageDir, linkPath, nodeModulesDir), false);
});

test("preserves an existing package directory with a different target", async () => {
  const { nodeModulesDir, packageDir, linkPath } = fixture("real-directory");
  mkdirSync(linkPath, { recursive: true });
  const marker = path.join(linkPath, "preserve.txt");
  writeFileSync(marker, "keep\n");

  await assert.rejects(createWorkspacePackageLink(packageDir, linkPath, nodeModulesDir), /preserving it/);
  assert.equal(readFileSync(marker, "utf8"), "keep\n");
});

test("preserves an existing non-owned symlink or junction", async () => {
  const { area, nodeModulesDir, packageDir, linkPath } = fixture("other-link");
  const otherTarget = path.join(area, "other-package");
  mkdirSync(otherTarget, { recursive: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  makeDirectoryLink(otherTarget, linkPath);

  await assert.rejects(createWorkspacePackageLink(packageDir, linkPath, nodeModulesDir), /preserving it/);
  assert.equal(realpathSync(linkPath), realpathSync(otherTarget));
});

test("rejects a linked node_modules parent before writing through it", async () => {
  const area = path.join(root, "linked-parent");
  const nodeModulesDir = path.join(area, "node_modules");
  const outside = path.join(area, "outside");
  const packageDir = path.join(area, "packages", "shared");
  const linkPath = path.join(nodeModulesDir, "@paperclipai", "shared");
  mkdirSync(outside, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  makeDirectoryLink(outside, nodeModulesDir);

  await assert.rejects(createWorkspacePackageLink(packageDir, linkPath, nodeModulesDir), /node_modules directory is linked/);
  assert.equal(existsSync(linkPath), false);
});
