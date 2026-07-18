import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadExternalAdapterPackage } from "../adapters/plugin-loader.js";
import { resolveDevTsxLoaderImportSpecifier } from "../services/plugin-loader.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
  }
});

describe("Windows-safe ESM path handling", () => {
  it("passes the repo-local tsx loader to Node as a file URL", () => {
    const specifier = resolveDevTsxLoaderImportSpecifier();
    const url = new URL(specifier);

    expect(url.protocol).toBe("file:");
    expect(path.isAbsolute(fileURLToPath(url))).toBe(true);
  });

  it("loads an external adapter from an absolute path containing spaces", async () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip adapter "));
    cleanupPaths.push(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ type: "module", exports: { ".": "./index.mjs" } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "index.mjs"),
      "export function createServerAdapter() { return { type: 'test_external_path' }; }\n",
      "utf8",
    );

    const adapter = await loadExternalAdapterPackage("test-external-path", packageRoot);
    expect(adapter.type).toBe("test_external_path");
  });
});
