import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package build script", () => {
  it("runs the cross-platform runtime asset copier after compilation", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toBe("tsc && node scripts/copy-build-assets.mjs");
  });

  it("copies nested and hidden assets and replaces stale files in an isolated fixture", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sps-build-assets-test-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      const script = path.join(root, "scripts/copy-build-assets.mjs");
      cpSync(fileURLToPath(new URL("../../scripts/copy-build-assets.mjs", import.meta.url)), script);
      for (const name of ["onboarding-assets", "built-ins"]) {
        mkdirSync(path.join(root, "src", name, "nested"), { recursive: true });
        mkdirSync(path.join(root, "dist", name), { recursive: true });
        writeFileSync(path.join(root, "src", name, "asset.txt"), `${name}:new`);
        writeFileSync(path.join(root, "src", name, "nested", ".license"), `${name}:license`);
        writeFileSync(path.join(root, "dist", name, "asset.txt"), "stale");
      }
      execFileSync(process.execPath, [script], { cwd: root, timeout: 10_000, stdio: "pipe" });
      for (const name of ["onboarding-assets", "built-ins"]) {
        expect(readFileSync(path.join(root, "dist", name, "asset.txt"), "utf8")).toBe(`${name}:new`);
        expect(readFileSync(path.join(root, "dist", name, "nested", ".license"), "utf8")).toBe(`${name}:license`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
