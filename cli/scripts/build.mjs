import { chmod } from "node:fs/promises";
import esbuild from "esbuild";

import config from "../esbuild.config.mjs";

await esbuild.build(config);
await chmod(new URL("../dist/index.js", import.meta.url), 0o755);
