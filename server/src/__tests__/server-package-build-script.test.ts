import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sps-build-assets-test-")));
    const parent = realpathSync(os.tmpdir());
    const identity = lstatSync(root, { bigint: true });
    try {
      mkdirSync(path.join(root, "scripts"));
      const script = path.join(root, "scripts/copy-build-assets.mjs");
      cpSync(fileURLToPath(new URL("../../scripts/copy-build-assets.mjs", import.meta.url)), script);
      for (const name of ["onboarding-assets", "built-ins", "native-runtime"]) {
        mkdirSync(path.join(root, "src", name, "nested"), { recursive: true });
        mkdirSync(path.join(root, "dist", name), { recursive: true });
        writeFileSync(path.join(root, "src", name, "asset.txt"), `${name}:new`);
        writeFileSync(path.join(root, "src", name, "nested", ".license"), `${name}:license`);
        writeFileSync(path.join(root, "dist", name, "asset.txt"), "stale");
      }
      const supervisorSource = path.join(root, "src", "native-runtime", "windows-job-supervisor");
      mkdirSync(supervisorSource, { recursive: true });
      for (const filename of ["WindowsJobSupervisor.cs", "supervisor.mjs"]) {
        cpSync(fileURLToPath(new URL(`../native-runtime/windows-job-supervisor/${filename}`, import.meta.url)),
          path.join(supervisorSource, filename));
      }
      execFileSync(process.execPath, [script], { cwd: root, timeout: 10_000, stdio: "pipe" });
      for (const name of ["onboarding-assets", "built-ins", "native-runtime"]) {
        expect(readFileSync(path.join(root, "dist", name, "asset.txt"), "utf8")).toBe(`${name}:new`);
        expect(readFileSync(path.join(root, "dist", name, "nested", ".license"), "utf8")).toBe(`${name}:license`);
      }
      for (const filename of ["WindowsJobSupervisor.cs", "supervisor.mjs"]) {
        expect(readFileSync(path.join(root, "dist", "native-runtime", "windows-job-supervisor", filename)))
          .toEqual(readFileSync(path.join(supervisorSource, filename)));
      }
    } finally {
      const current = lstatSync(root, { bigint: true });
      if (realpathSync(root) !== root || path.dirname(root) !== parent
        || !path.basename(root).startsWith("sps-build-assets-test-")
        || !current.isDirectory() || current.isSymbolicLink()
        || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) {
        throw new Error("Refusing to remove a changed asset-copy fixture directory.");
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
