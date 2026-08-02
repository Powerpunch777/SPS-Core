import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ENTRY_BUDGET_BYTES = 1_500_000;

export function moduleEntryPath(indexHtml) {
  const match = indexHtml.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i);
  if (!match) throw new Error("SPS UI build does not declare a module entry script.");
  return match[1];
}

export async function inspectSpsUiBundle(
  root,
  budgetBytes = DEFAULT_ENTRY_BUDGET_BYTES,
) {
  const dist = path.join(root, "ui", "dist");
  const indexHtml = await readFile(path.join(dist, "index.html"), "utf8");
  const entryUrl = moduleEntryPath(indexHtml);
  const entryFile = path.join(dist, entryUrl.replace(/^\/+/, ""));
  const entryBytes = (await stat(entryFile)).size;
  return {
    entryFile: path.relative(root, entryFile).replaceAll("\\", "/"),
    entryBytes,
    budgetBytes,
    withinBudget: entryBytes <= budgetBytes,
  };
}

async function main() {
  const root = path.resolve(process.cwd());
  const configuredBudget = Number(process.env.SPS_UI_ENTRY_BUDGET_BYTES);
  const budget = Number.isFinite(configuredBudget) && configuredBudget > 0
    ? configuredBudget
    : DEFAULT_ENTRY_BUDGET_BYTES;
  const result = await inspectSpsUiBundle(root, budget);
  const summary = `${result.entryFile}: ${result.entryBytes} bytes (budget ${result.budgetBytes})`;
  if (!result.withinBudget) {
    console.error(`SPS UI entry bundle exceeds its budget: ${summary}`);
    process.exitCode = 1;
    return;
  }
  console.log(`SPS UI entry bundle check passed: ${summary}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
