import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storybookConfigDir = path.join(repoRoot, "ui", "storybook", ".storybook");

function packageMetadata(entryPath) {
  let directory = path.dirname(entryPath);
  while (true) {
    const packageJsonPath = path.join(directory, "package.json");
    try {
      const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (metadata.name && metadata.version) return metadata;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not find package metadata for ${entryPath}`);
    }
    directory = parent;
  }
}

function resolveDocgenGlob() {
  const storybookEntry = createRequire(import.meta.url).resolve("@storybook/react-vite", {
    paths: [storybookConfigDir],
  });
  const storybookRequire = createRequire(storybookEntry);
  const docgenPackageName = "@joshwooding/vite-plugin-react-docgen-typescript";
  const docgenPackageDir = storybookRequire
    .resolve.paths(docgenPackageName)
    .map((basePath) => path.join(basePath, ...docgenPackageName.split("/")))
    .find((candidate) => existsSync(path.join(candidate, "package.json")));
  assert.ok(docgenPackageDir, `${docgenPackageName} must resolve from Storybook`);
  const docgenMetadata = JSON.parse(
    readFileSync(path.join(docgenPackageDir, "package.json"), "utf8"),
  );
  assert.equal(docgenMetadata.name, docgenPackageName);
  const docgenExport = docgenMetadata.exports?.["."];
  const docgenImportPath =
    typeof docgenExport === "string"
      ? docgenExport
      : docgenExport?.import ?? docgenExport?.default ?? docgenMetadata.module ?? docgenMetadata.main;
  assert.ok(docgenImportPath, `${docgenPackageName} must expose an import entry`);
  const docgenEntry = path.resolve(docgenPackageDir, docgenImportPath);
  const docgenRequire = createRequire(docgenEntry);
  const globEntry = docgenRequire.resolve("glob");
  const globRequire = createRequire(globEntry);
  const minimatchEntry = globRequire.resolve("minimatch");

  return {
    glob: globRequire("glob"),
    globMetadata: packageMetadata(globEntry),
    minimatchMetadata: packageMetadata(minimatchEntry),
  };
}

test("Storybook docgen resolves the patched glob and minimatch versions", () => {
  const { glob, globMetadata, minimatchMetadata } = resolveDocgenGlob();

  assert.equal(globMetadata.name, "glob");
  assert.equal(globMetadata.version, "14.0.3");
  assert.equal(minimatchMetadata.name, "minimatch");
  assert.equal(minimatchMetadata.version, "11.0.3");
  assert.equal(typeof glob.globSync, "function", "resolved glob must export globSync");
});

test("globSync keeps the docgen TSX include and ignore behavior", (t) => {
  const { glob } = resolveDocgenGlob();
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "sps-storybook-glob-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixtureRoot).startsWith("sps-storybook-glob-"));
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const fixtureFiles = [
    "src/Button.tsx",
    "src/nested/Panel.tsx",
    "src/Button.stories.tsx",
    "src/nested/Panel.stories.tsx",
    "src/excluded/Hidden.tsx",
    "src/notes.ts",
  ];
  for (const relativePath of fixtureFiles) {
    const absolutePath = path.join(fixtureRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, "export {};\n");
  }

  const matches = glob.globSync("**/*.tsx", {
    cwd: fixtureRoot,
    ignore: ["**/*.stories.tsx", "src/excluded/**"],
    nodir: true,
  });

  assert.deepEqual(
    matches.map((match) => match.split(path.sep).join("/")).sort(),
    ["src/Button.tsx", "src/nested/Panel.tsx"],
  );
});
