# SPS Core

SPS Core is the private local-first runtime embedded by SPS Desktop. It provides
the stable platform services that every SPS workflow can share while leaving
workflow meaning to plugins.

AI is optional. Plugins may implement ordinary UI, storage and automation
without Agent registration. Model APIs, process/CLI execution and external Agent
sessions are separate optional execution paths; OCE management is a separate
planned control-plane connector, not a required model provider. Existing
OpenClaw adapter code is not evidence of an OCE integration or production
runtime isolation. This Core remains private; the Plugin SDK remains public.

This repository is not the public Plugin SDK and is not the SPS release channel.
The public `SPS-Core-Compat` repository is an upstream-compatibility mirror only.

## Product Boundary

Core owns platform capabilities:

- SPS identity, sessions, tenant isolation, and audit records
- Host storage and project Source grants
- Node registration, signed command dispatch, runtime packs, and leases
- Agent adapter registration and execution plumbing
- plugin package verification, lifecycle, capabilities, jobs, and host services
- Marketplace catalog search and the adapter-backed Marketplace Assistant
- backup and recovery primitives consumed by Desktop's empty-Host restore flow,
  plus update compatibility checks

Plugins own workflow semantics:

- rooms, tasks, roles, reporting lines, and approval policy
- domain-specific navigation, dashboards, forms, and artifacts
- memory strategy above the Core storage and lifecycle contracts
- game, app, web, research, or any other operating model

The default bundled plugins are product choices, not hidden Core invariants.
Disabling a workflow plugin must not change the safety or durability of Core.

See [SPS Core Contract](doc/SPS-CORE-CONTRACT.md) before changing a schema,
route, service, UI surface, or plugin host capability.

## Compatibility Layer

SPS Core retains portions of Paperclip's schema, package names, routes, and
execution machinery while the compatibility layer is being isolated. Names such
as `company`, `issue`, `agent`, and `@paperclipai/*` may therefore remain in
internal code.

Those names are implementation compatibility, not permission to make SPS depend
on one company hierarchy or a single-assignee task workflow. New SPS contracts
must use SPS-owned namespaces or an explicitly documented compatibility adapter.
Existing compatibility behavior remains protected until a migration and rollback
path is available.

Plugin packages and worker lifecycle are Host-wide in the current runtime.
Workspace activation and plugin settings are scoped separately, so one installed
package can be available to multiple Workspaces without forcing every Workspace
to expose or use it.

## Repository Map

- `server/`: API, runtime orchestration, plugin host services, and compatibility adapters
- `ui/`: embedded SPS Workspace UI
- `packages/db/`: schema, migrations, and database clients
- `packages/shared/`: shared contracts and validators
- `packages/adapters/`: local and remote Agent runtime adapters
- `packages/plugins/`: plugin runtime packages
- `doc/`: engineering, migration, and upstream compatibility documentation

## Development

Requirements: Node.js and the pnpm version pinned by SPS-Source CI.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Commit dependency manifests and the matching `pnpm-lock.yaml` together. CI
validates that exact lockfile with frozen installs; it must not generate a
different dependency graph for tests or release packaging.

The embedded development server normally listens on `http://localhost:3100`.
SPS Desktop production builds launch Core as a private Owner Host runtime; the
development URL is not the product access surface.

Use the smallest relevant test while iterating. Before a PR-ready handoff run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

SPS-Source additionally verifies the exact Desktop/Core/Plugin SDK tuple and the
bundled plugin set before producing a release candidate.

## Upstream and Licensing

This private runtime contains code derived from the Paperclip project and keeps
the applicable copyright, license, and third-party notices. Upstream provenance
must remain inspectable even after SPS-owned contracts replace compatibility
surfaces.

- Upstream project: <https://github.com/paperclipai/paperclip>
- Upstream license: [LICENSE](LICENSE)
- SPS product and release repository: `Powerpunch777/SPS-Source` (private)
- Public plugin development surface: `Powerpunch777/sps-plugin-sdk`
