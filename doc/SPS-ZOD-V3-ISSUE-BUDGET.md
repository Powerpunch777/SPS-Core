# Zod v3 diagnostic memory bound

Core's exact Zod 3.25.76 package is patched through pnpm `patchedDependencies`.
The patch bounds retained validation diagnostics to 100 recursive issue records
per parse, including nested unions and function argument/return errors. It
retains detailed errors below the ceiling and reserves one custom overflow
issue. ESM and CommonJS runtime output are patched; public imports, schema types
and the SDK's existing v3 source contract remain unchanged.

Budget propagation uses a module-private Symbol, so public parse options cannot
replace it. Function wrappers allocate a fresh budget per invocation; repeated
invalid calls continue to throw ZodError and do not poison later valid calls.
Successful union alternatives and catch defaults remain successful. Existing
HTTP validation envelopes, coercion, strict records, serialized manifests and
MCP scalar limits have separate compatibility tests.

The version remains 3.25.76 and the audit finding remains active. This is a
diagnostic-memory mitigation, not an advisory waiver or full release clearance.
Input traversal and per-element parse allocations remain proportional to input;
request byte limits and collection constraints are still needed. Zod 4's bundled
v3 runtime and external copies are outside this exact package patch. Better
Auth's existing Zod 4 peer resolution is preserved. Public SDK releases are not
repinned by this change.

Verify with frozen pnpm install, the focused `zod-v3-issue-budget` and
`sps-validation-compatibility` suites, then complete full Core and shipped-runtime
verification. SPS-Source's installed-patch verifier checks the registered artifact
hash and actual ESM/CommonJS behavior; the current release audit is unchanged.
Removing the patch registration and regenerating the lock rolls back error
aggregation without a data migration, but restores unbounded issue growth.
