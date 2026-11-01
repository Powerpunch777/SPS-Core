import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEMP_PREFIX = "sps-token-gates-test-";
const CLI_PATH = fileURLToPath(new URL("./check-token-gates.mjs", import.meta.url));
const ALLOWED_SOURCE = [
  "export const Allowed = () => (",
  '  <div className="w-[17px] text-[13px]" style={{ color: "#123456" }} />',
  ");",
  "",
];

async function runFixture(t, newline, unlistedSource) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, TEMP_PREFIX));
  const original = await lstat(root, { bigint: true });
  t.after(async () => {
    assert.equal(path.resolve(root), root);
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith(TEMP_PREFIX));
    assert.equal(await realpath(parent), parent);
    assert.equal(await realpath(root), root);
    const current = await lstat(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    for (const field of ["dev", "ino", "birthtimeNs"]) {
      assert.equal(current[field], original[field]);
    }
    await rm(root, { recursive: true, force: false });
  });
  assert.ok(original.isDirectory() && !original.isSymbolicLink());
  assert.equal(await realpath(root), root);

  const scripts = path.join(root, "scripts");
  const components = path.join(root, "ui", "src", "components");
  await mkdir(scripts);
  await mkdir(components, { recursive: true });
  await mkdir(path.join(root, "ui", "src", "pages"));
  const cli = path.join(scripts, "check-token-gates.mjs");
  await copyFile(CLI_PATH, cli);
  await writeFile(path.join(root, "ui", "src", "index.css"), [
    "/*",
    " * allow ui/src/components/Allowed.tsx \u2014 existing fixture policy",
    " */",
    "",
  ].join(newline));
  await writeFile(path.join(components, "Allowed.tsx"), ALLOWED_SOURCE.join(newline));
  await writeFile(path.join(components, "Unlisted.tsx"), `${unlistedSource}${newline}`);

  const result = spawnSync(process.execPath, [cli], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return result;
}

function assertSummary(output, counts) {
  assert.match(output, /Files scanned:\s+2\b/);
  assert.match(output, /Allowlist entries loaded:\s+1\b/);
  assert.match(output, /Allowlisted issues skipped:\s+4\b/);
  for (const [index, count] of counts.entries()) {
    const expected = count === 0 ? "CLEAN" : `${count} violation\\(s\\)`;
    assert.match(output, new RegExp(`Gate ${index + 1}[^\\n]*:\\s+${expected}`));
  }
}

const unlistedCases = [
  { name: "color", source: 'export const Unlisted = <div style={{ color: "#fedcba" }} />;', counts: [1, 0, 0] },
  { name: "arbitrary value", source: 'export const Unlisted = <div className="min-w-[19px]" />;', counts: [0, 1, 0] },
  { name: "font literal", source: 'export const Unlisted = <div style={{ fontSize: "13px" }} />;', counts: [0, 0, 1] },
];

for (const [name, newline] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`${name}: existing allowlisted violations pass through the real CLI`, async t => {
    const result = await runFixture(t, newline, "export const Unlisted = <div />;");
    assert.equal(result.status, 0, result.stdout);
    assertSummary(result.stdout, [0, 0, 0]);
    assert.match(result.stdout, /All gates clean\./);
  });

  for (const fixture of unlistedCases) {
    test(`${name}: the real CLI rejects an unlisted ${fixture.name}`, async t => {
      const result = await runFixture(t, newline, fixture.source);
      assert.equal(result.status, 1, result.stdout);
      assertSummary(result.stdout, fixture.counts);
      assert.match(result.stdout, /ui\/src\/components\/Unlisted\.tsx:1\s/);
      assert.doesNotMatch(result.stdout, /ui\/src\/components\/Allowed\.tsx:/);
      assert.doesNotMatch(result.stdout, /All gates clean\./);
    });
  }
}
