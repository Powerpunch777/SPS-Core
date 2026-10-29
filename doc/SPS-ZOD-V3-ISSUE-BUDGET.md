# Zod package upgrade and v3 compatibility resource bounds

Current implementation (2026-10-29) supersedes the previous Zod3 mitigation.
Core's six workspace consumers pin official `zod` **4.6.6** and use the
official **`zod/v3`** compatibility entrypoint, including the internal SDK's `z`
re-export. This retains v3 errors/types and the existing OpenAPI converter.
Transitive dependencies keep standard v4 root exports. No package version or
export map is relabelled, and no advisory exception is added.

The upstream 4.6.6 size fix does not cover its bundled v3. Therefore the exact
official package has an SPS patch in both ESM and CommonJS v3 runtimes:

- Retain at most 100 recursive issues per parse, including an overflow marker.
  Function argument and return parses each get a fresh 99-issue allowance,
  reserving room for their outer error. Successful noisy arguments must not
  exhaust later return-validation diagnostics.
- Reject arrays over `.max()`/`.length()` and Sets over `.max()` before elements
  are read, preserving size metadata and aborting parent effects.
- Traverse Array/Set/Map lazily and stop failed collection parsing after issue
  exhaustion. Async parsing schedules batches of at most 32 elements rather
  than creating promises for the entire input. Successful later union branches
  and catch defaults remain successful.

Traversal is capped at the collection's initial cardinality, so callbacks that
append values cannot turn one parse into an expanding iteration. Values are read
lazily rather than fully snapshotted before callbacks begin.

The module-private budget Symbol remains non-overridable by public options.
Only four runtime files change: `v3/types.js`, `v3/types.cjs` and their
`helpers/parseUtil` files. Public declarations/exports are unmodified. The exact
patch hash is locked; LF patch bytes are enforced on Windows and Linux. The
old Zod3 patch is superseded.

Observable changes: over-limit invalid collections omit element diagnostics;
their containing union can now report `invalid_union`. After diagnostic
exhaustion remaining failed-element diagnostics/effects are omitted. Async
callback scheduling is batched; callers must not rely on every element callback
starting at once. Existing valid data, low-volume paths/messages, coercion,
defaults, strictness, manifest and MCP JSON contracts remain required.

This is not a global CPU/memory/input-byte quota. Valid large collections,
objects/records, JSON decoding, deep schemas and arbitrary custom callbacks still
require their own input limits. Keep HTTP byte limits and route cardinality
checks. Independent external dependencies and the separately installed excluded
Kubernetes sandbox provider are not repinned. The public SPS SDK repository has
no Zod dependency.

Verify with frozen install, focused issue-budget/validation compatibility tests,
shared/SDK/server/MCP compilation, SDK-consuming Workspace plugin tests and actual
MCP schema handling. Source's installed-copy and packaged-runtime verifiers
separately check upstream v4 root guards and patched v3 issue/work bounds. The
packaged verifier has a fresh 128MiB-heap process; virtual-input read guards fail
broken implementations before exhausting memory. Missing-guard/budget, identity,
version and dependency-escape negative fixtures remain required.

An audit checks the pinned graph; it does not prove every runtime property.
Release CI and actual packaged Windows qualification remain separate gates.
Copied fixtures are not installed-app acceptance evidence. Rollback restores
manifests, imports, patch registration and lock together, followed by reinstall;
there is no user-data migration. The rolled-back vulnerable graph must not be
presented as release-qualified.
