# Zod v3 validation resource mitigation

Core's exact Zod 3.25.76 package is patched through pnpm `patchedDependencies`.
The patch has two bounded protections:

- It caps retained recursive diagnostic issues at 100 per parse, including
  nested unions and function argument/return errors. It retains detailed issues
  below the ceiling and reserves one custom overflow issue.
- Before traversing values, it rejects arrays over an explicit `.max()` or
  `.length()` upper bound, and Sets over an explicit `.max()` bound. Existing
  size-issue metadata is preserved. This prevents per-element parse/result
  allocations for those over-cap collections. ESM and CommonJS runtime output
  are patched; public imports, schema types and the SDK's v3 source contract
  remain unchanged.

Budget propagation uses a module-private Symbol, so public parse options cannot
replace it. Function wrappers allocate a fresh budget per invocation; repeated
invalid calls continue to throw ZodError and do not poison later valid calls.
Valid under-cap arrays, refinements, successful union alternatives and catch
defaults continue to work. Existing HTTP validation envelopes, coercion, strict
records, serialized manifests and MCP scalar limits have separate compatibility
tests.

The early rejection changes behavior for **oversized invalid values**. The
existing size error and metadata remain; invalid child-element diagnostics are
omitted. The parser returns an aborted result after recording the size issue,
so parent refinements/transforms do not receive a synthetic empty collection.
This can change a union error: a formerly dirty over-cap array branch whose
elements all parsed could be selected as the union error; it is now aborted and
the union can return `invalid_union`. These input error details are observable
and must be reviewed as part of this mitigation.

This is not a full advisory fix, waiver, or release clearance. Unbounded arrays
still traverse all elements and retain at most 100 issues; arbitrary parse work
is still proportional to input. Map constraints, unbounded Sets, nested union
work, JSON decoding and non-HTTP inputs are not bounded by the new early checks.
Request byte limits and explicit per-route/per-collection cardinality limits
remain necessary. Zod 4's bundled v3 runtime and external copies are outside
this exact package patch. Better Auth's existing Zod 4 peer resolution is
preserved. Public SDK releases are not repinned by this change. The High audit
finding remains active with no exception.

Verify the exact patched runtime with frozen pnpm install, the focused
`zod-v3-issue-budget` and `sps-validation-compatibility` suites, then complete
full Core and shipped-runtime verification. SPS-Source's installed-patch
verifier checks the registered artifact hash and actual ESM/CommonJS behavior;
the current release audit remains unchanged. Removing the patch registration
and regenerating the lock rolls back the bounded behavior without a data
migration.
