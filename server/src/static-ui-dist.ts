import fs from "node:fs";
import path from "node:path";

/** Source checkouts must not silently serve an old packaging copy of the UI. */
export function resolveStaticUiDist(serverDirectory: string, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  const workspaceRoot = path.resolve(serverDirectory, "../..");
  if (exists(path.join(workspaceRoot, "pnpm-workspace.yaml")) && exists(path.join(workspaceRoot, "ui", "package.json"))) {
    const sourceDist = path.join(workspaceRoot, "ui", "dist");
    // Fail to API-only if source UI has not been built; never certify stale UI.
    return exists(path.join(sourceDist, "index.html")) ? sourceDist : undefined;
  }
  const packagedDist = path.resolve(serverDirectory, "../ui-dist");
  return exists(path.join(packagedDist, "index.html")) ? packagedDist : undefined;
}
