import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, "..");
const sourceDirectory = path.join(packageRoot, "src", "migrations");
const destinationDirectory = path.join(packageRoot, "dist", "migrations");

// TypeScript does not copy SQL or migration metadata. Use Node APIs so the
// packaged Owner Host stays reproducible on Windows, macOS, and Linux.
await rm(destinationDirectory, { recursive: true, force: true });
await cp(sourceDirectory, destinationDirectory, { recursive: true });
