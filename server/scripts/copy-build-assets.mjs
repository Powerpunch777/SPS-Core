import { cp, mkdir } from "node:fs/promises";

const assets = ["onboarding-assets", "built-ins", "native-runtime"];

for (const name of assets) {
  const source = new URL(`../src/${name}/`, import.meta.url);
  const destination = new URL(`../dist/${name}/`, import.meta.url);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
