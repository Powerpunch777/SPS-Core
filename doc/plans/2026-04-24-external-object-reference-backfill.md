# External Object Reference Backfill

> **Historical/compatibility design reference (2026-11-02 classification).**
> [SPS normative baseline](../SPS-DOCUMENTATION-BASELINE-2026-11-02.md) takes precedence over product assumptions below.
> Paperclip Company/Issue/org/Agent/UI models are compatibility, not mandatory SPS behavior.
> Do not force Core chrome, Builder, AI or a workflow through this reference; preserve APIs/data pending explicit migration.
> Documentation classification only; implementation and dated test results are unchanged.

## Purpose

Backfill existing issue titles, descriptions, comments, and documents into `external_object_mentions` after the Phase 3 detector registry and mention sync service exist.

## Command Shape

Add a command parallel to the internal issue-reference backfill:

```sh
pnpm external-objects:backfill
pnpm external-objects:backfill -- --company <company-id>
pnpm external-objects:backfill -- --dry-run
```

## Required Behavior

- Scan issue title and description sources, issue comments, and issue documents through the same external-object mention sync service used by write hooks.
- Preserve company boundaries: every scan query, mention upsert, object upsert, and dry-run summary must include `company_id`.
- Use shared URL extraction and canonicalization helpers so raw URLs, URL userinfo, query strings, and fragments are never persisted.
- Replace mentions per source instead of appending, using the same source key shape as live write sync.
- Report counts by company, source kind, provider key, object type, skipped userinfo URLs, and unresolved URLs.
- Default to a non-interactive safe run; `--dry-run` must avoid writes while still reporting what would change.

## Phase 3 Hook

The command should be implemented only after the detector registry can classify URLs and the service can upsert mentions/placeholders consistently. Until then, Phase 2 owns the schema and shared helpers that make the command safe.
