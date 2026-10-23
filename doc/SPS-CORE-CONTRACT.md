# SPS Core Contract

Status: current engineering contract

## Goal

SPS Core is the durable, workflow-neutral runtime embedded by SPS Desktop. A
user can enable different workflow plugins without replacing the identity,
storage, execution, safety, recovery, or update foundations of the product.

## Core-Owned Contracts

Core owns these cross-workflow contracts:

1. Identity, SPS sessions, tenant boundaries, and audit records.
2. Workspace lifecycle and Host-owned Source grants.
3. Node registration, per-user Agent access, signed commands, leases, runtime
   allowlists, and fail-closed revocation.
4. Agent adapter registration and execution transport.
5. Host-wide Plugin package verification and worker lifecycle, plus
   Workspace-scoped activation, capability grants, settings, jobs, navigation
   slots, diagnostics, and rollback.
6. Generic durable storage and events exposed through versioned plugin host
   services.
7. Core Marketplace catalog search, plugin details, and the read-only,
   adapter-backed Marketplace Assistant tool bridge. Desktop currently
   materializes the trusted local catalog consumed by this service.
8. Backup, update compatibility, and recovery primitives. SPS Desktop owns the
   complete transfer-bundle and empty-Host restore orchestration.

Core contracts describe capabilities and safety. They do not prescribe how a
team plans or assigns work.

## Plugin-Owned Contracts

Plugins own domain semantics, including:

- Room, Task, ticket, conversation, or other work-unit models.
- Lead, Worker, reviewer, approver, or other workflow roles.
- Assignment cardinality, status transitions, wake rules, and completion policy.
- Domain dashboards, inbox interpretation, navigation, forms, and artifacts.
- Memory summarization and retrieval strategy built on Core lifecycle/storage.

A bundled plugin may be enabled by default without becoming a Core invariant.

## Compatibility Boundary

Plugin Agent sessions carry their message as generic conversation context.
Their adapter invocation must not inherit the default issue/heartbeat work
mandate. Agent model, approved instructions, workspace, secrets, and execution
safety remain unchanged. Conversation UI and Lead/Worker semantics remain
plugin-owned; ordinary issue runs retain their compatibility behavior.

The current implementation is transitioning from Paperclip-derived internals.
The following may remain temporarily:

- `company`, `issue`, `task`, `agent`, and heartbeat-oriented schema or services;
- `@paperclipai/*` package names;
- `PAPERCLIP_*` environment variables;
- Profile 1.0 plugin bridge contracts;
- upstream tests and documents needed to preserve inherited behavior.

These are compatibility implementation details. New SPS features must not use
them as the only public contract. Prefer SPS-owned modules and adapters that can
later be redirected to neutral storage and execution services.

SPS-owned server and UI modules consume retained dependencies through
`server/src/compat/paperclip/` and `ui/src/compat/paperclip/`. The
`pnpm check:sps-compat-boundary` gate rejects new direct imports from the owned
surface. Add a narrow facade export with an explicit migration reason instead
of bypassing this gate.

## Change Rules

Own-plugin cross-lane history is available through `sps.executions.list/get`
under `sps.executions.read` (`executions.observe`). The existing `sps.runs.read`
grant remains Node-only. Lists are bounded chronological pages with a composite
millisecond timestamp / run UUID / lane cursor. They are live history, not a frozen
accounting snapshot. Agent-session history uses the Core-written conversation
ownership snapshot, not a live session row or current Agent configuration.
Deleting that session does not itself delete the retained execution record.

The common DTO exposes safe runtime/model metadata, technical phase, duration,
cancellation intent/termination and coarse failure categories. `requires_review`
is not permission to retry a task. Raw arguments, prompts, output, environment,
paths and error messages are not part of this read model. Existing detailed APIs
retain their separate access contracts.

New Agent-session completions preserve a versioned usage-evidence snapshot:
explicit per-run adapter values are `reported`; deltas derived from session totals
are `estimated`; missing/invalid values are `unavailable` and null, never fabricated
zero. Adapter reports are not provider invoices. Subscription reference cost is
not an incremental API charge. Cost additionally requires explicit adapter
`costUsdBasis: per_run`; token scope alone is insufficient. Existing adapters that
do not supply cost scope retain unknown cost in this DTO (including legacy zero
defaults); their raw ledger is unchanged. Old unmarked records and neutral Node usage remain
unavailable in this DTO. No historical usage backfill, ledger replacement, receipt
deduplication, budget enforcement or automatic business decisions are added here.
These are unreleased pinned-source additions, not features of the published SDK tag.

Agent sessions separately expose `agents.sessions.getRun` (`agent.sessions.read`)
and `agents.sessions.cancel` (`agent.sessions.cancel`). These require explicit
Workspace, session and run IDs and verify the exact Plugin namespace, Agent and
conversation context. They do not cancel all runs for an Agent or delete sessions.
The safe read model includes technical status, cancellationRequested and
termination (`not_applicable`, `pending`, `confirmed`), not output or credentials.
Cancellation status alone is not a termination receipt. Remote commands keep a
durable cancellation marker and lose their lease; completion is acknowledged by
the signed Node. Local completion checks the recorded process scope. Unknown or
disconnected execution remains pending. Repeating a pending request can resume a
failed control-plane operation; it never retries the underlying AI task. A durable
cancellation suppresses inherited automatic run-recovery retries.
These additions remain unreleased pinned-source contracts. They do not change
workflow ownership, undo file changes, or define child task cancellation policy.

Neutral plugin execution exposes additive `sps.runs.list` (read capability) and
`sps.runs.cancel` (separate cancellation capability). Both are Workspace- and
Plugin-scoped; they do not control Agent sessions or grant access to another
plugin's executions. Lists are bounded, descending UUID pages, not chronological
history. Existing get/events/artifact methods remain unchanged.

Queued work may become `cancelled` immediately. Claimed/running work becomes
`cancelling`; it becomes `cancelled` only when the signed Node reports completion.
An offline Node leaves cancellation pending. Neither an HTTP acknowledgement nor
a timer is proof of process exit. Node completion is application-level evidence;
workflow success and reassignment remain plugin-owned. New capability declarations
are rejected by older Hosts that do not support them; unchanged protocol major
versions do not imply availability. These additions are development-only until a
new compatible Core/SDK release is published.

1. Do not delete compatibility behavior without data migration, plugin impact,
   rollback, and release evidence.
2. Do not add a second direct dependency on a legacy domain when a compatibility
   adapter can contain it.
3. Core UI may render generic plugin slots and platform settings; workflow UI is
   contributed by plugins.
4. Installation, Source access, Node execution, restore, and updates require the
   explicit authority defined by Core. Plugins may request but cannot bypass it.
5. Marketplace Assistant search and detail tools are read-only. Recommendation
   does not silently install or activate a plugin.
6. Every new public contract requires a version, compatibility behavior, tests,
   and an ownership declaration (Core or Plugin).
7. A Marketplace `source.id` or trust label is presentation metadata, not proof
   of signature or freshness. Core must not accept a widened or remote catalog
   source until provenance, signature/hash, expiry, and fail-closed behavior are
   verified at the catalog boundary. The current local catalog path assumes
   Desktop has already materialized trusted data.
8. Core UI routes must remain independently loadable. The production build is
   checked by `pnpm check:sps-ui-bundle`; increasing the entry budget requires
   measured startup evidence and an explicit contract review.

## Migration Direction

1. Isolate legacy reads and writes behind compatibility modules.
2. Add neutral SPS-owned storage and execution contracts alongside them.
3. Migrate bundled plugins and Desktop to the neutral contracts.
4. Provide data and plugin compatibility migration with rollback.
5. Remove legacy public exposure only after supported plugins and two stable
   compatibility windows have passed.

This migration is incremental. A compatibility type remaining in the database
does not make it part of the long-term SPS product model.
