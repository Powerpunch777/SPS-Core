# Plugin package removal recovery

Status: implementation under verification. This document does not certify Core
completion, installer qualification or all package-operation crash recovery.

## Durable removal intent

The product Core composition supplies a Host-private database journal to the
plugin lifecycle and loader. Before deleting package artifacts, lifecycle drains
the existing Workspace scope, acquires the existing package-maintenance permit
and confirms the tracked Host worker has closed. It then commits a removal
intent and a non-running plugin status in one database transaction. Failure or
uncertainty while persisting this intent cannot authorize artifact deletion.

The intent retains the original plugin identity, exact package metadata/path,
manifest and the requested data-removal policy. It contains no plugin config or
Secret values. There is deliberately no cascading plugin foreign key: a hard
uninstall must not destroy the recovery record before its completion is known.
Only one active intent per plugin is allowed; completed records remain history.

Pending removal blocks lifecycle changes and loader activation/replacement. A
different data-removal policy cannot silently replace an existing request.
The persisted non-running status also denies Workspace worker admission under
the existing authority revision checks. Internal package installation checks
pending intent for the manifest key before committing a new install.

## Restart and retry

Normal product startup reconciles pending removal before bundle installation,
refresh and `loadAll`. It does not run package recovery in all-disabled Core
recovery mode. An invalid or unreadable journal prevents ordinary startup work.
An individually blocked removal stays pending while unrelated plugins can load.

Recovery compares current package identity, path, version and manifest with the
recorded snapshot. A replacement plugin, a changed path, or an invalid record
does not authorize deleting anything. If hard uninstall committed but its
response was lost, the surviving intent can complete without a plugin row,
provided its key has not been reused. Soft-removal recovery requires the row.

Every cleanup attempt still uses the manager's exact closure check, the scoped
maintenance permit, and the loader's existing owned-path classifier. Shared npm
cleanup still needs the exclusive maintenance window. Caller-owned local
checkouts remain preserved. Journal presence is not process-exit evidence,
arbitrary path-deletion authority, or an OS sandbox.

Artifacts are cleaned before registry soft/hard removal. The intent completes
only after both return successfully. A crash or lost response in between leaves
the intent available for idempotent reconciliation. No directory-age scan or
unreferenced-path sweep is introduced.

## Compatibility and remaining work

Migration0177 adds a new table without altering existing application rows or
SDK/API payloads. Metadata-only lifecycle compositions retain their existing
behavior unless supplied the store; product `app.ts` always supplies it.
Compatible rollback must preserve the table. An older binary does not understand
pending intents; do not use it to resume package mutations or erase this state.

Host backup restore retires pending deletion authority and marks those journal
records `cancelled_after_restore`, preserving their snapshots as history. A
restored backup cannot replay deletion against another machine's paths. The
plugin's non-running status remains; the Host must review it before another
explicit lifecycle action. Completed history is not changed by this sanitizer.

This increment records removal intent. Installation-stage recovery, upgrade
snapshot/activation recovery, previous-artifact retirement and runtime-cache
power-loss recovery remain separate required work. Existing uncertain-commit
artifact preservation is not a durable upgrade journal. Windows Job ownership
and physical installed-app qualification require their own evidence.

## Verification for this increment

- New lifecycle recovery tests passed11/11; existing cleanup/startup tests
  passed10/10. They retain exact closure, permit and normal startup assertions.
- The existing install/upgrade/restart/start-fence selection passed38/38.
  After adding pending-key/prepared-commit denial cases, the private-npm file
  separately passed15/15. These overlapping runs are not summed.
- Real PostgreSQL journal tests passed6/6 without skips: transaction/quarantine,
  database reconnect persistence, repeated reservation and policy conflict,
  hard-delete survival, completion, invalid records/rollback, restore retirement.
  The fixture applies all migrations through0177 and confirms owned cleanup.
- Restore sanitizer unit tests passed12/12. Migration safety/numbering checks,
  DB build and server typecheck passed. Generated SQL/snapshot are copied into
  the DB build artifacts used by runtime packaging.

The new PostgreSQL suite initially failed its30second setup allowance. A separate
owned-fixture diagnostic measured57seconds for initialization plus migrations,
then verified real reconnect/removal/restore behavior and confirmed cleanup at
67seconds. The new suite's setup allowance is90seconds; its6assertion cases and
30second cleanup allowance are retained. No product startup/exit deadline changed.
Earlier setup failures are not counted as passes. No installed customer DB was used.

Exact-candidate CI and rebuilt packaged Windows acceptance remain pending. These
source and synthetic-DB results do not establish all Core or release completion.

## Upgrade migration failure guard

Declared plugin migrations commit before worker startup. An activation failure
after entering a pending-migration upgrade does not prove those SQL changes
rolled back. Lifecycle therefore preserves the new package pointer, records an
error status and tries the existing exact-close/runtime cleanup fence. It returns
`plugin_upgrade_data_recovery_required` instead of automatically restoring and
restarting old code against a possibly newer schema. Unconfirmed cleanup never
authorizes old-code reactivation. Artifacts and the approved pre-migration Host
backup remain available; this guard does not automatically restore that backup.

Failures before entering candidate activation, or upgrades with no pending
migrations, keep the existing package rollback. Seventeen upgrade safety tests
passed, including4new controlled cases for this boundary. These are lifecycle
tests with a migration-plan fake, not proof of a real schema downgrade. Durable
upgrade phase/snapshot recovery and installed rollback qualification remain open.

The first Source0285ff7 compatibility CI blocked direct legacy imports in the new
SPS-owned journal service. The follow-up routes those imports through the existing
explicit compatibility facade; the rule and its assertions are retained.
The boundary check and its3regression tests passed; the combined lifecycle
removal/upgrade selection passed28/28, and final server `tsc --noEmit` passed.
Source0285ff7 Linux serialized3/4 job123349007577 also ran the real PostgreSQL
journal suite:6/6passed with no skips. Other exact-candidate gates remain separate.
