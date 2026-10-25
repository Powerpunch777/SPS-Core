import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReleasePackagePlan,
  checkConfiguration,
  findUnpublishableWorkspaceEdges,
  getReleasePackages,
  loadReleaseManifest,
  normalizePackageDir,
  replaceWorkspaceDeps,
} from "./release-package-map.mjs";

function pkg(name, { publishFromCi, ...deps } = {}) {
  return { name, dir: name, publishFromCi, pkg: { name, ...deps } };
}

test("normalizes Windows package paths to the POSIX manifest form", () => {
  assert.equal(
    normalizePackageDir(String.raw`packages\plugins\plugin-workspace-diff`),
    "packages/plugins/plugin-workspace-diff",
  );
  assert.equal(
    normalizePackageDir("./packages/plugins/plugin-workspace-diff/"),
    "packages/plugins/plugin-workspace-diff",
  );
});

test("release package manifest covers all public packages with explicit CI enrollment", () => {
  const packages = buildReleasePackagePlan();
  assert.ok(packages.length > 0);
  assert.ok(packages.every((pkg) => typeof pkg.publishFromCi === "boolean"));
});

test("release package list only contains CI-enrolled packages", () => {
  const enabledPackages = getReleasePackages();
  assert.ok(enabledPackages.length > 0);
  assert.ok(enabledPackages.every((pkg) => pkg.publishFromCi === true));
});

test("private SPS MCP runtime stays buildable but outside the public release graph", () => {
  const mcpServer = JSON.parse(
    readFileSync(new URL("../packages/mcp-server/package.json", import.meta.url), "utf8"),
  );
  const plan = buildReleasePackagePlan();
  const manifest = loadReleaseManifest();
  const expectedBins = {
    "sps-mcp-server": "./dist/stdio.js",
    "sps-marketplace-assistant-mcp": "./dist/marketplace-assistant-stdio.js",
  };

  assert.equal(mcpServer.private, true);
  assert.equal(mcpServer.publishConfig.access, undefined);
  assert.equal(manifest.some((entry) => entry.name === "@sps/mcp-server"), false);
  assert.equal(plan.some((pkg) => pkg.name === "@sps/mcp-server"), false);
  assert.equal(plan.find((pkg) => pkg.dir === "server")?.publishFromCi, false);
  assert.equal(plan.find((pkg) => pkg.dir === "cli")?.publishFromCi, false);
  assert.equal(mcpServer.scripts.build, "tsc");
  assert.deepEqual(mcpServer.bin, expectedBins);
  assert.deepEqual(mcpServer.publishConfig.bin, expectedBins);
  assert.equal(mcpServer.publishConfig.main, "./dist/index.js");
  assert.equal(mcpServer.publishConfig.types, "./dist/index.d.ts");
  assert.deepEqual(mcpServer.publishConfig.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.ok(mcpServer.files.includes("dist"));
});

test("Hermes release surface publishes the unified built-in package and keeps gateway as a shim", () => {
  const packages = buildReleasePackagePlan();
  const hermes = packages.find((pkg) => pkg.name === "@paperclipai/hermes-paperclip-adapter");
  const gatewayShim = packages.find((pkg) => pkg.name === "@paperclipai/adapter-hermes-gateway");

  assert.equal(hermes?.dir, "packages/adapters/hermes");
  assert.equal(hermes?.publishFromCi, true);
  assert.equal(gatewayShim?.dir, "packages/adapters/hermes-gateway");
  assert.equal(gatewayShim?.publishFromCi, false);
});

test("release package configuration validates successfully", () => {
  assert.doesNotThrow(() => checkConfiguration());
});

test("server publish lifecycle keeps ui-dist available through payload collection", () => {
  const server = buildReleasePackagePlan().find(
    (pkg) => pkg.name === "@paperclipai/server",
  );

  assert.ok(server);
  assert.equal(server.pkg.scripts?.postpack, undefined);
});

test("plugin publish lifecycles use the cross-platform package helpers", () => {
  const plugins = buildReleasePackagePlan().filter(
    ({ pkg }) => pkg.spsPlugin || pkg.paperclipPlugin,
  );

  assert.ok(plugins.length > 0);
  for (const plugin of plugins) {
    assert.match(
      plugin.pkg.scripts?.prepack ?? "",
      /^node .*generate-plugin-package-json\.mjs$/,
      `${plugin.name} prepack`,
    );
    assert.match(
      plugin.pkg.scripts?.postpack ?? "",
      /^node .*restore-package-json\.mjs$/,
      `${plugin.name} postpack`,
    );
  }
});

test("UI publish lifecycle uses the cross-platform package helpers", () => {
  const ui = buildReleasePackagePlan().find(
    (pkg) => pkg.name === "@paperclipai/ui",
  );

  assert.ok(ui);
  assert.equal(ui.pkg.scripts?.prepack, "node ../scripts/generate-ui-package-json.mjs");
  assert.equal(ui.pkg.scripts?.postpack, "node ../scripts/restore-package-json.mjs");
});

test("guard flags a publishFromCi:true package depending on a publishFromCi:false package", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/skills-catalog": "workspace:*" },
    }),
    pkg("@paperclipai/skills-catalog", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@paperclipai\/server/);
  assert.match(problems[0], /@paperclipai\/skills-catalog/);
});

test("guard inspects optional and peer dependency sections too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      optionalDependencies: { "@paperclipai/opt": "workspace:^" },
      peerDependencies: { "@paperclipai/peer": "workspace:*" },
    }),
    pkg("@paperclipai/opt", { publishFromCi: false }),
    pkg("@paperclipai/peer", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 2);
});

test("guard treats a workspace dep on an unknown @paperclipai package as unpublishable", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/private-internal": "workspace:*" },
    }),
  ]);

  assert.equal(problems.length, 1);
});

test("guard allows true->true workspace edges", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@paperclipai/shared": "workspace:*" },
    }),
    pkg("@paperclipai/shared", { publishFromCi: true }),
  ]);

  assert.deepEqual(problems, []);
});

test("guard checks workspace edges for SPS package namespaces too", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: { "@sps/mcp-server": "workspace:*" },
    }),
    pkg("@sps/mcp-server", { publishFromCi: false }),
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /@sps\/mcp-server/);
});

test("version rewrite replaces workspace dependencies for every enrolled package namespace", () => {
  assert.deepEqual(
    replaceWorkspaceDeps(
      {
        "@paperclipai/shared": "workspace:*",
        "@sps/mcp-server": "workspace:^",
        "@paperclipai/not-in-release": "workspace:*",
        zod: "^3.0.0",
      },
      "2026.802.0",
      new Set(["@paperclipai/shared", "@sps/mcp-server"]),
    ),
    {
      "@paperclipai/shared": "2026.802.0",
      "@sps/mcp-server": "2026.802.0",
      "@paperclipai/not-in-release": "workspace:*",
      zod: "^3.0.0",
    },
  );
});

test("guard ignores non-workspace specs, non-internal deps, and edges from off-train packages", () => {
  const problems = findUnpublishableWorkspaceEdges([
    pkg("@paperclipai/server", {
      publishFromCi: true,
      dependencies: {
        "@paperclipai/pinned": "0.3.1",
        zod: "^3.0.0",
      },
    }),
    pkg("@paperclipai/pinned", { publishFromCi: false }),
    pkg("@paperclipai/offtrain", {
      publishFromCi: false,
      dependencies: { "@paperclipai/also-off": "workspace:*" },
    }),
    pkg("@paperclipai/also-off", { publishFromCi: false }),
  ]);

  assert.deepEqual(problems, []);
});

test("the live release manifest has no unpublishable workspace edges", () => {
  assert.deepEqual(findUnpublishableWorkspaceEdges(buildReleasePackagePlan()), []);
});
