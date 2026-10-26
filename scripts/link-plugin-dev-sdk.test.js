import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, before, test } from "node:test";

import { linkSdkInto, readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "link-plugin-dev-sdk-"));
});

after(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function makePackage(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

function makeDirectoryLink(target, link) {
  if (process.platform === "win32") {
    symlinkSync(target, link, "junction");
  } else {
    symlinkSync(target, link, "dir");
  }
}

test("readPluginsUnder returns [] for a missing directory", () => {
  assert.deepEqual(readPluginsUnder(join(workDir, "does-not-exist")), []);
});

test("readPluginsUnder finds first-level package directories", () => {
  const parent = join(workDir, "first-level");
  const a = makePackage(join(parent, "a"));
  const b = makePackage(join(parent, "b"));

  assert.deepEqual(readPluginsUnder(parent).sort(), [a, b].sort());
});

test("readPluginsUnder recurses into directories that are not themselves packages", () => {
  // Mirrors the recursive pnpm-workspace exclusion glob: a provider nested
  // deeper than one level must still be discovered.
  const parent = join(workDir, "nested");
  const nested = makePackage(join(parent, "vendor", "my-plugin"));

  assert.deepEqual(readPluginsUnder(parent), [nested]);
});

test("readPluginsUnder stops descending once a package.json is found and skips node_modules", () => {
  const parent = join(workDir, "boundaries");
  const pkg = makePackage(join(parent, "plugin"));
  // A nested package inside an already-matched package must not be returned.
  makePackage(join(pkg, "sub-package"));
  // node_modules must be ignored entirely.
  makePackage(join(parent, "node_modules", "some-dep"));

  assert.deepEqual(readPluginsUnder(parent), [pkg]);
});

test("linkSdkInto creates a platform-compatible SDK directory link and is idempotent", () => {
  const pkg = makePackage(join(workDir, "link-target"));

  assert.equal(linkSdkInto(pkg), true);

  const link = join(pkg, "node_modules", "@paperclipai", "plugin-sdk");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link).toLowerCase(), realpathSync(new URL("../packages/plugins/sdk", import.meta.url)).toLowerCase());
  if (process.platform === "win32") {
    assert.ok(isAbsolute(readlinkSync(link)), "Windows junction target must be absolute");
  }

  // Second call is a no-op because the link already resolves to the in-repo SDK.
  assert.equal(linkSdkInto(pkg), false);
});

test("linkSdkInto leaves a real (non-symlink) install in place", () => {
  const pkg = makePackage(join(workDir, "real-install"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  // Simulate a published-tarball install: a real directory, not a symlink.
  makePackage(join(scopeDir, "plugin-sdk"));

  assert.equal(linkSdkInto(pkg), false);
  assert.ok(!lstatSync(join(scopeDir, "plugin-sdk")).isSymbolicLink());
});

test("linkSdkInto preserves a non-owned directory link", () => {
  const pkg = makePackage(join(workDir, "stale-link"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  const otherTarget = makePackage(join(workDir, "other-sdk"));
  const link = join(scopeDir, "plugin-sdk");
  makeDirectoryLink(otherTarget, link);
  const originalTarget = readlinkSync(link);

  assert.equal(linkSdkInto(pkg), false);
  assert.equal(readlinkSync(link), originalTarget);
  assert.equal(realpathSync(link), realpathSync(otherTarget));
  assert.ok(existsSync(scopeDir));
});
