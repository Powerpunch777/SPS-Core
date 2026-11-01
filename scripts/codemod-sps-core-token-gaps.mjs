import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
if (process.argv.slice(2).some(arg => arg !== "--check")) throw Error("Unknown token codemod option.");
const files = new Map([
  ["ui/src/components/SpsCoreDashboard.tsx", new Map([
    ["tracking-[0.12em]", "tracking-normal"],
    ["tracking-tight", "tracking-normal"],
    ["xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.85fr)]", "xl:grid-cols-(--gtc-sps-core-dashboard)"],
  ])],
  ["ui/src/components/StatusIcon.tsx", new Map([["text-[10px]", "text-(length:--text-nano)"]])],
  ["ui/src/pages/Dashboard.tsx", new Map([
    ["lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]", "lg:grid-cols-(--gtc-sps-home-dashboard)"],
  ])],
  ["ui/src/pages/SpsCoreServerSettings.tsx", new Map([["min-w-[16rem]", "min-w-(--sz-16rem)"]])],
]);

let changed = 0;
for (const [relative, replacements] of files) {
  const file = path.join(root, relative);
  const before = await readFile(file, "utf8");
  const source = ts.createSourceFile(file, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (source.parseDiagnostics.length) throw Error("Cannot rewrite invalid TSX.");
  const edits = [];
  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className"
      && node.initializer && ts.isStringLiteral(node.initializer)) {
      const previous = node.initializer.text;
      const next = previous.split(/\s+/).map(value => replacements.get(value) ?? value).join(" ");
      if (next !== previous) edits.push({ start: node.initializer.getStart(source), end: node.initializer.end,
        text: JSON.stringify(next) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!edits.length) continue;
  changed++;
  if (check) continue;
  let after = before;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  }
  await writeFile(file, after, "utf8");
}
console.log(JSON.stringify({ spsCoreTokenCodemod: true, check, filesChanged: changed }));
if (check && changed) process.exitCode = 1;
