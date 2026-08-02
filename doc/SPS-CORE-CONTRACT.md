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

## Change Rules

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

## Migration Direction

1. Isolate legacy reads and writes behind compatibility modules.
2. Add neutral SPS-owned storage and execution contracts alongside them.
3. Migrate bundled plugins and Desktop to the neutral contracts.
4. Provide data and plugin compatibility migration with rollback.
5. Remove legacy public exposure only after supported plugins and two stable
   compatibility windows have passed.

This migration is incremental. A compatibility type remaining in the database
does not make it part of the long-term SPS product model.
