# Workspace Plugin workers

This optional execution contract belongs to SPS Core. A Plugin owns its handler
behavior; Core owns process identity, configuration, admission, capabilities and
cleanup. Legacy packages continue to use their existing Host worker and global
configuration. This feature does not migrate those records.

## Completion boundary

The implementation provides logical Workspace authorization and a separate
process for each declared `(Workspace, Plugin)` worker. It is not a completed
untrusted-code sandbox or a Windows release qualification.

| Boundary | Current implementation | Remaining qualification |
| --- | --- | --- |
| Worker ownership | Separate process and service adapters for each declared Workspace worker | Actual Windows Desktop stop, restart and recovery acceptance |
| Core access | Current invocation, Workspace policy and execution epoch checks; per-Workspace configuration | Broader regression and release evidence for the integrated candidate |
| Progress delivery | Scoped local SSE subscriptions, generation fences and bounded queues | Actual Windows Desktop scoped streaming acceptance |
| Operating system access | Worker runs under the Host OS account | Filesystem, network and credential isolation for untrusted code |
| Existing packages | Legacy Host workers retain their existing execution contract | Packages must explicitly adopt `workspaceWorker` to use this execution lane |

Passing scoped RPC tests does not prove OS isolation. A process can use its OS
account directly without calling a Core adapter; unsupported Host RPCs do not
prevent that access. Do not describe every installed Plugin as Workspace-isolated.

## Manifest and configuration

```json
{
  "entrypoints": {
    "worker": "./dist/host.js",
    "workspaceWorker": "./dist/workspace.js"
  },
  "workspaceConfigSchema": {
    "type": "object",
    "properties": { "label": { "type": "string" } },
    "additionalProperties": false
  }
}
```

These are fields within the ordinary complete manifest. `workspaceWorker` is
an optional package-relative file; it must resolve inside the installed package,
including after symlink resolution. Core never substitutes the Host entrypoint
when the declared Workspace entrypoint is unavailable.

`workspaceConfigSchema` is inline, synchronous JSON Schema. Secret-reference
schemas and async schemas are rejected. A missing schema permits only `{}`.
Configuration starts at `{}` and never inherits global Plugin settings or
credentials. Required fields must be saved before the worker can initialize.
Broker connection UUIDs may be stored as ordinary settings; they confer no grant.
This JSON configuration is not an encrypted credential store.

Host management uses
`/api/plugins/:pluginId/companies/:companyId/workspace-runtime-config`:
GET reads a snapshot; PUT saves `configJson` with `expectedRevision`; DELETE
resets it with `expectedRevision`. A missing record has a null revision. Mutations
require Host and Workspace authority and compare revisions under row locks.
Concurrent changes require an explicit refresh. After a committed change, failure
to confirm the old process has stopped returns a fixed 503 with the saved
revision; it does not roll back the saved configuration or replay an action.

## Process and authority

Each `(Workspace, Plugin)` owns a separate process, fresh Host-service adapters
and immutable startup config. Local Desktop UI and Native UI data/actions share
the same process pool. A declared Workspace worker requires explicit matching
Workspace authority; there is no fallback to a global worker. Legacy undeclared
packages keep the existing Host route.

Calls are bound to the Workspace execution epoch and current Plugin policy.
Startup can read only its owned config without an invocation token; subsequent
Host RPCs require a current matching invocation. Stale policy, config, stopped
execution or an invalid invocation fences further Host work. Process restart is
lazy, and does not replay an interrupted user action.

The supported Host API subset covers owned config/state/entities, Inbox,
declared local folders, SPS execution/history, connectivity, model broker,
granted runs/artifacts, lifecycle publication and activity logging. The SDK's
capability and underlying service authorization still apply. Generic SQL, direct
HTTP, raw secret resolution, event subscriptions, tools, jobs and global lifecycle
registration are unavailable in this lane. Lifecycle publication reaches the
Core event bus; disposing one worker never clears another worker's subscriptions.

Stopping a Workspace joins only its owned processes and startup work. An
unconfirmed child close retains the exact handle and services and prevents
replacement. Pending Plugin counts include these owned resources, in addition to
durable execution records. Shutdown remains closed to new calls; a failed cleanup
attempt may be retried after the owned child can be closed.

These processes run under the Host's OS account. They are not a Windows filesystem,
network or Vault sandbox. Process ownership and Host RPC checks alone do not
qualify untrusted Plugin execution, physical Native LAN, or a production release.

## Local Desktop progress streams

Core composes the retained SDK stream notification bus with the ordinary Desktop
SSE bridge. A UI subscribes to its Plugin/channel/Workspace tuple before starting
an action. The worker calls `streams.open`, `streams.emit` and `streams.close`.
The declared Workspace lane admits notifications only from the exact active
UI/action invocation, matching owner and current authority. Ending, aborting or
timing out that RPC closes its channels; it does not create a background lease
or extend the action deadline. Legacy Host workers retain their existing stream
lifetime, and cannot publish into a declared Workspace worker's stream tuples.

Each process receives an opaque private generation identifier. A retired
generation cannot emit into or close a replacement generation's stream. The
factory checks current config/policy/execution before publication, including a
synchronous originating-call fence after asynchronous checks. Failed process
cleanup retains ownership rather than handing a stream to a new process.
Stream callbacks preserve their originating child's stdout order; matching RPC
responses drain preceding callbacks before settling the invocation. Notification
admission is bounded per child and overflow closes its channels and denies further
stream notifications for that child.

SSE readers recheck current session or board credential, current membership
(with the existing trusted Host exception), Plugin availability, private policy
revision and execution epoch on delivery and periodic checks. A changed revision,
revoked credential or stopped epoch ends the subscription. Queues, payloads,
channels and slow-client waits are bounded. The ordinary UI keeps only its newest
128 messages and ignores callbacks from a superseded Workspace/connection.
These ephemeral messages are not durable history and have no replay contract.
Core shutdown closes idle subscriptions as well as active channels synchronously,
without another session/database lookup, and terminally rejects new subscriptions.

Native Plugin windows still reject the stream hook until an authenticated Native
stream transport and its window/credential teardown are implemented and verified.
The local SSE bridge does not add a Native LAN or generic EventBus subscription.

## Storage and rollback

Migration 0173 adds `sps_workspace_plugin_runtime_configs`, keyed by Workspace and
Plugin with cascading ownership. Configuration changes rotate their revision and
Workspace Plugin authority; restore rotates configuration revisions as well.
Audit entries contain the operation and revision, not settings values.

No existing global config, manifest worker, package or Workspace setting row is
rewritten. Downgrading code must leave the additive table intact. Older Core
versions do not implement this entrypoint contract and must not be used with
packages requiring it; install a compatible package version with the older Core.
Existing global worker support does not authorize substituting it for this lane.
