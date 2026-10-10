import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNpm(args: string[], options: Parameters<typeof execFileSync>[2]) {
  if (process.platform !== "win32") return execFileSync("npm", args, options);
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error(`npm CLI was not found beside Node: ${npmCli}`);
  return execFileSync(process.execPath, [npmCli, ...args], options);
}

function runPnpm(args: string[], options: Parameters<typeof execFileSync>[2]) {
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli && existsSync(pnpmCli)) return execFileSync(process.execPath, [pnpmCli, ...args], options);
  return execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, options);
}

function readPackMetadata(packDestination: string) {
  const output = String(runNpm(["pack", "--json", "--pack-destination", packDestination], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  const metadata = JSON.parse(output);
  if (!Array.isArray(metadata) || metadata.length === 0 || typeof metadata[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output from ${packageRoot}: ${output}`);
  }
  return metadata[0] as { filename: string; files: Array<{ path: string }> };
}

describe("skills catalog package artifacts", () => {
  const cleanup: string[] = [];

  function createPackDestination() {
    const destination = mkdtempSync(path.join(tmpdir(), "paperclip-skills-catalog-pack-"));
    cleanup.push(destination);
    return destination;
  }

  afterEach(async () => {
    await Promise.all(cleanup.map((entry) => rm(entry, { force: true, recursive: true })));
    cleanup.length = 0;
  });

  it("packs dist manifest and catalog files for npm artifact consumers", () => {
    let metadata = readPackMetadata(createPackDestination());

    if (!metadata.files.some((entry) => entry.path === "dist/generated/catalog.json")) {
      runPnpm(["--filter", "@paperclipai/skills-catalog", "build"], {
        cwd: packageRoot,
        stdio: "ignore",
      });
      metadata = readPackMetadata(createPackDestination());
    }

    const paths = metadata.files.map((entry) => entry.path);

    expect(paths).toContain("dist/generated/catalog.json");
    expect(paths).toContain("generated/catalog.json");
    expect(paths).toContain("catalog/bundled/software-development/github-pr-workflow/SKILL.md");
    expect(paths).toContain("catalog/optional/browser/agent-browser/SKILL.md");
    expect(paths).toContain("package.json");
  }, 120_000);
});
