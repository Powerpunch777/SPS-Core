#!/usr/bin/env node

import { rmSync } from "node:fs";
import path from "node:path";

rmSync(path.resolve(process.cwd(), "dist"), { force: true, recursive: true });
