# AGENTS.md

Guidance for human and AI contributors working in SPS Core.

## 1. Purpose

SPS Core is the workflow-neutral platform runtime embedded by SPS Desktop. It
provides identity, durable storage, Host and Node execution, Agent adapter
plumbing, plugin lifecycle, recovery, and other shared safety boundaries.

Workflow semantics belong to plugins. Do not make Rooms, Tasks, org charts,
approval flows, or a particular development process mandatory Core behavior.

## 2. Read This First

Before making changes, read in this order:

1. `doc/SPS-CORE-CONTRACT.md`
2. `README.md`
3. the closest package or directory `AGENTS.md`, when present
4. the relevant schema, route, service, UI, and tests
5. upstream documents under `doc/` only when working on retained compatibility

The historical Paperclip product specifications describe inherited behavior.
They are not the SPS product contract unless `doc/SPS-CORE-CONTRACT.md` or an
SPS-owned test explicitly adopts that behavior.

## 3. Repository Map

- `server/`: API, orchestration services, plugin host, and compatibility adapters
- `ui/`: embedded SPS Workspace UI
- `packages/db/`: schema, migrations, and database clients
- `packages/shared/`: shared types, constants, validators, and API paths
- `packages/adapters/`: Agent runtime adapters
- `packages/plugins/`: plugin runtime packages
- `doc/`: engineering and compatibility documentation

## 4. Core Engineering Rules

1. Preserve tenant isolation.
Every durable entity must have an enforceable tenant boundary. The current
compatibility schema often calls that tenant a `company`; do not expose the
legacy term as a new public SPS product requirement.

2. Keep contracts synchronized.
Schema or API changes must update the affected DB exports, shared contracts,
server routes and services, UI clients, tests, and migrations.

3. Keep Core workflow-neutral.
New SPS behavior must not require the inherited single-assignee issue model,
org-chart reporting, heartbeat task checkout, or Paperclip approval semantics.
Plugins may adopt those behaviors through documented capabilities.

4. Preserve compatibility deliberately.
Existing company, issue, task, agent, and `@paperclipai/*` behavior remains a
compatibility constraint until SPS provides a migration and rollback path. Put
new adapters in an explicit compatibility namespace; do not spread new direct
dependencies on legacy domain types.

5. Fail closed at trust boundaries.
Identity, Node execution, Source grants, plugin capabilities, package signatures,
leases, restore, and update compatibility must reject ambiguous or stale input.

6. Keep product ownership clear.
Core may provide generic storage, events, jobs, navigation slots, diagnostics,
and host services. A plugin owns the domain meaning of data rendered through
those capabilities.

7. Avoid unrelated migrations and refactors.
Large legacy modules are being split incrementally. Extract one coherent domain
at a time and preserve behavior with focused tests.

8. Preserve catalog trust provenance.
The Marketplace search service currently consumes a local catalog materialized
by SPS Desktop. A catalog `source.id` or displayed trust label is not a signature
check. Do not add arbitrary remote catalog input or elevate trust without a
verified Source, hash/signature evidence, freshness policy, and fail-closed tests.

## 5. Database Change Workflow

When changing the data model:

1. Edit `packages/db/src/schema/*.ts`.
2. Export new tables from `packages/db/src/schema/index.ts`.
3. Generate the migration with `pnpm db:generate`.
4. Validate with focused tests and `pnpm -r typecheck`.
5. Document compatibility, rollback, and data ownership when the change touches
   an inherited Paperclip table.

Never silently reinterpret existing rows as a new SPS contract.

## 6. API and Auth Expectations

- Base path: `/api`.
- Enforce tenant access in routes and services.
- Agent and Marketplace Assistant credentials are scoped capabilities, not board
  administrator sessions.
- Node commands require signed authority, an active lease, an allowed runtime,
  and an authorized Source grant.
- Marketplace Assistant tools remain read-only catalog tools unless a separate,
  explicit Host action performs installation.

## 7. Verification Before Handoff

Run the smallest relevant check first. Before claiming broad or PR-ready Core
work complete, run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

Run browser or release smoke suites when the affected surface requires them.
SPS-Source owns final candidate tuple, Desktop, bundled-plugin, and physical
Host/Member release evidence. Report every check that could not be run.

For UI changes, follow `DESIGN.md` and run:

```sh
pnpm check:token-gates
```

When opening a pull request, read and complete every section of
`.github/PULL_REQUEST_TEMPLATE.md`, including reasoning, verification, risks,
model use, and checklist items.

## 8. Documentation and Attribution

- SPS-owned plans belong in the SPS-Source product documentation unless the plan
  is only about this Core repository.
- Keep applicable Paperclip and third-party license notices intact.
- Do not present inherited upstream marketing or workflow rules as current SPS
  product behavior.
- Use `SPS`, `Workspace`, `Host`, `Member`, `Node`, `Source`, and `Plugin` on new
  product-facing surfaces unless a compatibility API requires a legacy name.

## 9. Definition of Done

A Core change is done only when:

1. It follows `doc/SPS-CORE-CONTRACT.md` and identifies Core or Plugin ownership.
2. Relevant tests, typecheck, build, and UI token gates pass.
3. DB, shared, server, UI, migration, and compatibility contracts stay aligned.
4. Documentation and rollback notes match the implemented behavior.
5. The pull request follows the repository template and reports unrun checks.
