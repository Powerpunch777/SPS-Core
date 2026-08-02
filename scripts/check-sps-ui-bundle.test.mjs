import assert from "node:assert/strict";
import test from "node:test";
import { moduleEntryPath } from "./check-sps-ui-bundle.mjs";

test("extracts the Vite module entry", () => {
  assert.equal(
    moduleEntryPath('<script type="module" crossorigin src="/assets/index-abc.js"></script>'),
    "/assets/index-abc.js",
  );
});

test("rejects an index without a module entry", () => {
  assert.throws(() => moduleEntryPath("<html></html>"), /module entry script/);
});
