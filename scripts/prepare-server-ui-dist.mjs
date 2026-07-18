#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const uiDist = path.join(rootDir, "ui", "dist");
const serverUiDist = path.join(rootDir, "server", "ui-dist");
const reuseExistingUiDist = /^(1|true|yes)$/i.test(
  process.env.PAPERCLIP_RELEASE_REUSE_UI_DIST ?? "",
);

if (reuseExistingUiDist && fs.existsSync(path.join(uiDist, "index.html"))) {
  console.log("  -> Reusing existing @paperclipai/ui dist output");
} else {
  console.log("  -> Building @paperclipai/ui...");
  const result = spawnSync("pnpm", ["--dir", rootDir, "--filter", "@paperclipai/ui", "build"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(uiDist, "index.html"))) {
  throw new Error(`UI build output missing at ${path.join(uiDist, "index.html")}`);
}

fs.rmSync(serverUiDist, { recursive: true, force: true });
fs.cpSync(uiDist, serverUiDist, { recursive: true });
console.log("  -> Copied ui/dist to server/ui-dist");
