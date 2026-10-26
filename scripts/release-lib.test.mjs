import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getReleasePackages } from "./release-package-map.mjs";

function toBashPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

const repoRoot = toBashPath(fileURLToPath(new URL("..", import.meta.url))).replace(/\/$/, "");

function writeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function runPublishHelper({
  pnpmMode,
  npmVersionExists = false,
  distTag = "canary",
  callerPipefail = true,
  helper = "publish",
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-release-lib-"));
  const binDir = join(fixtureDir, "bin");
  const stateDir = join(fixtureDir, "state");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  writeFileSync(callLog, "");

  writeExecutable(
    join(binDir, "pnpm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
case "$PNPM_MODE" in
  success)
    echo "published"
    exit 0
    ;;
  preview-success)
    printf 'hidden detail\nsummary one\nsummary two\nsummary three\n'
    exit 0
    ;;
  preview-failure)
    printf 'root publish error\ncontext line\n'
    exit 42
    ;;
  tlog-then-success)
    if [ ! -f "$FAKE_STATE_DIR/pnpm-called" ]; then
      touch "$FAKE_STATE_DIR/pnpm-called"
      echo "npm error code TLOG_CREATE_ENTRY_ERROR"
      echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
      exit 1
    fi
    case " $* " in
      *" --provenance=false "*)
        echo "published without provenance"
        exit 0
        ;;
      *)
        echo "retry did not disable provenance"
        exit 1
        ;;
    esac
    ;;
  tlog-always-fails)
    echo "npm error code TLOG_CREATE_ENTRY_ERROR"
    echo "npm error error creating tlog entry - (409) an equivalent entry already exists in the transparency log with UUID abc"
    exit 1
    ;;
  non-tlog-failure)
    echo "npm error code E500"
    exit 1
    ;;
esac
exit 1
`,
  );

  writeExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
if [ "$1" = "view" ] && [ "$NPM_VERSION_EXISTS" = "true" ]; then
  echo "1.2.3"
  exit 0
fi
exit 1
`,
  );

  const shellOptions = callerPipefail ? "set -euo pipefail" : "set -eu";
  const helperCall =
    helper === "preview"
      ? `preview_package_publish ${distTag}`
      : `publish_package_to_npm ${distTag} @paperclipai/example 1.2.3`;
  const script = `
${shellOptions}
export PATH="${toBashPath(binDir)}:$PATH"
source "${repoRoot}/scripts/release-lib.sh"
${helperCall}
`;
  const runnerPath = join(fixtureDir, "run-helper.sh");
  writeExecutable(runnerPath, script);

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [runnerPath], {
      cwd: fixtureDir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_CALL_LOG: toBashPath(callLog),
        FAKE_STATE_DIR: toBashPath(stateDir),
        NPM_VERSION_EXISTS: npmVersionExists ? "true" : "false",
        PNPM_MODE: pnpmMode,
        REPO_ROOT: toBashPath(fixtureDir),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  return {
    calls: readFileSync(callLog, "utf8"),
    output,
    status,
  };
}

function removeOwnedCliVersionFixture(fixtureDir, expectedFixtureDir, canonicalTempRoot) {
  const originalStat = lstatSync(fixtureDir);
  if (!originalStat.isDirectory() || originalStat.isSymbolicLink()) {
    throw new Error("refusing to remove a non-directory or linked CLI release fixture");
  }

  const canonicalFixtureDir = realpathSync(fixtureDir);
  const relativeFixture = relative(canonicalTempRoot, canonicalFixtureDir);
  const isOwnedChild =
    relativeFixture !== "" &&
    relativeFixture !== ".." &&
    !relativeFixture.startsWith(`..${sep}`) &&
    !isAbsolute(relativeFixture);
  if (
    !isOwnedChild ||
    dirname(canonicalFixtureDir) !== canonicalTempRoot ||
    !basename(canonicalFixtureDir).startsWith("paperclip-release-cli-version-") ||
    expectedFixtureDir !== resolve(canonicalTempRoot, basename(fixtureDir)) ||
    canonicalFixtureDir !== expectedFixtureDir
  ) {
    throw new Error("refusing to remove a CLI release fixture outside its owned temp directory");
  }

  const canonicalStat = lstatSync(canonicalFixtureDir);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error("refusing to remove a non-directory or linked CLI release fixture");
  }

  rmSync(canonicalFixtureDir, { recursive: true, force: true });
}

function runCliVersionAssertion({ releasePlan, cliVersion, targetVersion }) {
  const canonicalTempRoot = realpathSync(tmpdir());
  const fixtureDir = mkdtempSync(join(canonicalTempRoot, "paperclip-release-cli-version-"));
  const expectedFixtureDir = realpathSync(fixtureDir);
  try {
    const releaseScript = readFileSync(new URL("./release.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const helper = releaseScript.match(/^assert_cli_release_version_if_enrolled\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(helper, "release.sh must define the CLI release-plan version assertion");
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ version: cliVersion }));

    let status = 0;
    let output = "";
    try {
      output = execFileSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            helper,
            'release_info() { printf "%s\\n" "$*"; }',
            'release_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
            'assert_cli_release_version_if_enrolled "$VERSIONED_PACKAGE_INFO" "$TARGET_PUBLISH_VERSION"',
          ].join("\n"),
        ],
        {
          cwd: fixtureDir,
          encoding: "utf8",
          env: {
            ...process.env,
            CLI_DIR: toBashPath(fixtureDir),
            TARGET_PUBLISH_VERSION: targetVersion,
            VERSIONED_PACKAGE_INFO: releasePlan,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      status = error.status ?? 1;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }

    return { status, output };
  } finally {
    removeOwnedCliVersionFixture(fixtureDir, expectedFixtureDir, canonicalTempRoot);
  }
}

test("release script asserts CLI version only when CLI is in the trusted CI publish plan", () => {
  const releaseScript = readFileSync(new URL("./release.sh", import.meta.url), "utf8");
  assert.match(releaseScript, /VERSIONED_PACKAGE_INFO="\$\(list_public_package_info\)"/);
  assert.match(
    releaseScript,
    /assert_cli_release_version_if_enrolled "\$VERSIONED_PACKAGE_INFO" "\$TARGET_PUBLISH_VERSION"/,
  );

  const cliPackage = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8"));
  const targetVersion = "2026.1025.0-canary.7";
  const currentReleasePackages = getReleasePackages();
  const currentReleasePlan = currentReleasePackages
    .map(({ dir, name, version }) => `${dir}\t${name}\t${version}`)
    .join("\n");
  assert.equal(currentReleasePackages.some(({ dir }) => dir === "cli"), false);
  assert.notEqual(cliPackage.version, targetVersion);

  const offTrain = runCliVersionAssertion({
    releasePlan: currentReleasePlan,
    cliVersion: cliPackage.version,
    targetVersion,
  });
  assert.equal(offTrain.status, 0);
  assert.match(offTrain.output, /not part of this publish plan/);

  const enrolledPlan = `cli\tpaperclipai\t${targetVersion}`;
  const enrolledMismatch = runCliVersionAssertion({
    releasePlan: enrolledPlan,
    cliVersion: cliPackage.version,
    targetVersion,
  });
  assert.notEqual(enrolledMismatch.status, 0);
  assert.match(enrolledMismatch.output, /versioning drift detected/);
  assert.ok(enrolledMismatch.output.includes(`Expected ${targetVersion} but found ${cliPackage.version}`));

  const enrolledMatch = runCliVersionAssertion({
    releasePlan: enrolledPlan,
    cliVersion: targetVersion,
    targetVersion,
  });
  assert.equal(enrolledMatch.status, 0);
  assert.doesNotMatch(enrolledMatch.output, /versioning drift detected/);
});

test("publish_package_to_npm returns after a successful pnpm publish", () => {
  const result = runPublishHelper({ pnpmMode: "success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --no-git-checks --tag canary --access public$/m);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm retries duplicate tlog failures without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.match(
    result.calls,
    /^pnpm publish --no-git-checks --tag canary --access public --provenance=false$/m,
  );
});

test("publish_package_to_npm treats a duplicate tlog failure as complete when npm exposes the version", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-always-fails", npmVersionExists: true });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry unrelated publish failures", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure" });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not mask failures when caller has no pipefail", () => {
  const result = runPublishHelper({ pnpmMode: "non-tlog-failure", callerPipefail: false });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.calls, /npm view/);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("publish_package_to_npm does not retry stable publishes without provenance", () => {
  const result = runPublishHelper({ pnpmMode: "tlog-then-success", distTag: "latest" });

  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^npm view @paperclipai\/example@1\.2\.3 version$/m);
  assert.doesNotMatch(result.calls, /--provenance=false/);
});

test("preview_package_publish keeps successful output concise", () => {
  const result = runPublishHelper({ pnpmMode: "preview-success", distTag: "latest", helper: "preview" });

  assert.equal(result.status, 0);
  assert.match(result.calls, /^pnpm publish --dry-run --no-git-checks --tag latest$/m);
  assert.doesNotMatch(result.output, /hidden detail/);
  assert.match(result.output, /summary one\nsummary two\nsummary three/);
});

test("preview_package_publish preserves failures and their full diagnostics", () => {
  const result = runPublishHelper({ pnpmMode: "preview-failure", distTag: "latest", helper: "preview" });

  assert.equal(result.status, 42);
  assert.match(result.output, /root publish error\ncontext line/);
});
