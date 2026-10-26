import assert from "node:assert/strict";
import test from "node:test";
import {
  importedModuleSpecifiers,
  isDirectLegacyImport,
  isSpsOwnedSource,
} from "./check-sps-compat-boundary.mjs";

test("recognizes SPS-owned production modules and excludes tests", () => {
  assert.equal(isSpsOwnedSource("server/src/routes/sps-nodes.ts"), true);
  assert.equal(isSpsOwnedSource("ui/src/pages/SpsCoreWorkspaceHome.tsx"), true);
  assert.equal(isSpsOwnedSource("server/src/routes/sps-nodes.test.ts"), false);
  assert.equal(isSpsOwnedSource("server/src/routes/issues.ts"), false);
});

test("extracts static and dynamic imports", () => {
  assert.deepEqual(
    importedModuleSpecifiers(`
      import { agents } from "@paperclipai/db";
      const module = import('../services/access.js');
    `),
    ["@paperclipai/db", "../services/access.js"],
  );
});

test("blocks inherited direct imports but allows the compatibility facade", () => {
  assert.equal(isDirectLegacyImport("@paperclipai/shared"), true);
  assert.equal(isDirectLegacyImport("../services/heartbeat.js"), true);
  assert.equal(isDirectLegacyImport("../compat/paperclip/shared.js"), false);
});
