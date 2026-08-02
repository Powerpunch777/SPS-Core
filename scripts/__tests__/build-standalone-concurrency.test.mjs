import assert from "node:assert/strict";
import test from "node:test";

import {
  createStandaloneWorkspacePolicy,
  resolveConcurrency,
  resolvePackageManagerInvocation,
  runCaptured,
  runWithConcurrency,
} from "../build-standalone-public-packages.mjs";

test("runs the package manager through Node when npm_execpath is a JS entrypoint", () => {
  assert.deepEqual(
    resolvePackageManagerInvocation(
      { npm_execpath: "C:/tools/pnpm.cjs" },
      "win32",
    ),
    { command: process.execPath, argsPrefix: ["C:/tools/pnpm.cjs"] },
  );
});

test("uses an explicit platform executable when npm_execpath is a command shim", () => {
  assert.deepEqual(
    resolvePackageManagerInvocation(
      { npm_execpath: "C:/tools/pnpm.cmd" },
      "win32",
    ),
    { command: "pnpm.cmd", argsPrefix: [] },
  );
  assert.deepEqual(
    resolvePackageManagerInvocation({}, "linux"),
    { command: "pnpm", argsPrefix: [] },
  );
});

test("includes command, working directory, and exit details when execution fails", async () => {
  await assert.rejects(
    () =>
      runCaptured(
        process.execPath,
        ["-e", "process.exitCode = 7"],
        process.cwd(),
        () => {},
      ),
    (error) => {
      assert.match(error.message, /Command:/);
      assert.match(error.message, /Working directory:/);
      assert.match(error.message, /Exit code: 7/);
      assert.match(error.message, /Error code:/);
      return true;
    },
  );
});

test("copies the root allowBuilds policy to standalone projects", () => {
  const policy = createStandaloneWorkspacePolicy(`packages:\n  - packages/*\n\nallowBuilds:\n  esbuild: true\n  protobufjs: true\n`);

  assert.match(policy, /allowBuilds:\n\s+esbuild: true\n\s+protobufjs: true/);
  assert.doesNotMatch(policy, /packages:/);
});

test("rejects a root without an explicit build allowlist", () => {
  assert.throws(
    () => createStandaloneWorkspacePolicy("packages:\n  - packages/*\n"),
    /missing allowBuilds policy/,
  );
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runs every item and preserves result order", async () => {
  const items = [1, 2, 3, 4, 5];
  const results = await runWithConcurrency(items, 2, async (value) => value * 10);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("never exceeds the concurrency limit", async () => {
  const items = Array.from({ length: 8 }, (_, index) => index);
  const limit = 3;
  let active = 0;
  let peak = 0;
  const gates = items.map(() => deferred());

  const run = runWithConcurrency(items, limit, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    assert.ok(active <= limit, `active ${active} exceeded limit ${limit}`);
    await gates[value].promise;
    active -= 1;
    return value;
  });

  // Release gates progressively; the pool must keep at most `limit` in flight.
  for (const gate of gates) {
    await Promise.resolve();
    gate.resolve();
  }

  await run;
  assert.equal(peak, limit);
});

test("aggregates failures and still runs remaining items", async () => {
  const items = [0, 1, 2, 3];
  const processed = [];

  await assert.rejects(
    () =>
      runWithConcurrency(items, 2, async (value) => {
        processed.push(value);
        if (value === 1) {
          throw new Error(`boom-${value}`);
        }
        return value;
      }),
    (error) => {
      assert.match(error.message, /1 standalone package build\(s\) failed/);
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0].index, 1);
      assert.match(error.failures[0].error.message, /boom-1/);
      assert.match(error.message, /\[1\] boom-1/);
      return true;
    },
  );

  // A single failure must not abort the rest of the queue.
  assert.deepEqual(processed.sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("reports failures sorted by original index", async () => {
  const items = [0, 1, 2, 3, 4];

  await assert.rejects(
    () =>
      runWithConcurrency(items, 5, async (value) => {
        if (value === 3 || value === 1) {
          throw new Error(`fail-${value}`);
        }
        return value;
      }),
    (error) => {
      assert.deepEqual(
        error.failures.map(({ index }) => index),
        [1, 3],
      );
      return true;
    },
  );
});

test("resolveConcurrency honors a valid env override, capped by package count", () => {
  const previous = process.env.STANDALONE_BUILD_CONCURRENCY;
  try {
    process.env.STANDALONE_BUILD_CONCURRENCY = "2";
    assert.equal(resolveConcurrency(7), 2);
    assert.equal(resolveConcurrency(1), 1);
    assert.equal(resolveConcurrency(0), 1);

    process.env.STANDALONE_BUILD_CONCURRENCY = "0";
    assert.ok(resolveConcurrency(7) >= 1);

    process.env.STANDALONE_BUILD_CONCURRENCY = "not-a-number";
    assert.ok(resolveConcurrency(7) >= 1);
  } finally {
    if (previous === undefined) {
      delete process.env.STANDALONE_BUILD_CONCURRENCY;
    } else {
      process.env.STANDALONE_BUILD_CONCURRENCY = previous;
    }
  }
});

test("resolveConcurrency never returns more than the package count", () => {
  const previous = process.env.STANDALONE_BUILD_CONCURRENCY;
  try {
    delete process.env.STANDALONE_BUILD_CONCURRENCY;
    assert.equal(resolveConcurrency(0), 1);
    assert.ok(resolveConcurrency(3) <= 3);
  } finally {
    if (previous !== undefined) {
      process.env.STANDALONE_BUILD_CONCURRENCY = previous;
    }
  }
});
