#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const uiDir = path.join(rootDir, "ui");
const uiDist = path.join(rootDir, "ui", "dist");
const serverUiDist = path.join(rootDir, "server", "ui-dist");
const reuseExistingUiDist = /^(1|true|yes)$/i.test(
  process.env.PAPERCLIP_RELEASE_REUSE_UI_DIST ?? "",
);

if (reuseExistingUiDist && fs.existsSync(path.join(uiDist, "index.html"))) {
  console.log("  -> Reusing existing @paperclipai/ui dist output");
} else {
  console.log("  -> Building @paperclipai/ui...");
  // Invoke the installed Vite CLI with Node instead of a package-manager shell
  // wrapper. This keeps workspace paths containing spaces as one argument.
  const viteCli = path.join(uiDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteCli)) {
    throw new Error(`UI build dependency missing at ${viteCli}. Run pnpm install first.`);
  }
  const result = spawnSync(process.execPath, [viteCli, "build"], {
    cwd: uiDir,
    stdio: "inherit",
    shell: false,
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
