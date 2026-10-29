# Plugin package lifecycle recovery

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

Normal product startup reconciles pending package operations before bundle installation,
refresh and `loadAll`. It does not run package recovery in all-disabled Core
recovery mode. An invalid or unreadable journal prevents ordinary startup work.
An individually blocked operation stays pending while unrelated plugins can load.
Recovery rereads the pending record inside its process-mutation fence; a completed
or restore-cancelled intent captured by an older startup scan cannot run again.

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

Removal and approved-upgrade intent use the same table. Installation-stage
recovery, the capability-approval-pending upgrade branch, candidate retirement,
previous-artifact retirement
and runtime-cache power-loss recovery remain separate required work. Windows
Job ownership and physical installed-app qualification need their own evidence.

## Durable upgrade phases

After validating the candidate and satisfying existing capability/data approval
and backup requirements, Core persists both previous/candidate snapshots,
migration-plan hash, backup reference and `prepared` phase. This transaction
also makes the plugin non-running. It precedes old runtime teardown and pointer
replacement; it is not exit evidence. The full product shares one store between
lifecycle, loader and Workspace workers.

Core then records `committing` before changing the pointer, `committed` afterwards,
and `activation_entered` before calling candidate activation. Normal phase skips
and rewinds are rejected. A Core decision to roll back is first persisted as
`rollback_required`, before restoring old metadata. This preserves the known-safe
decision even when the activation-phase write or rollback completion response
is lost. The data-migration activation-failure guard below never makes that
old-code rollback decision after it has entered a pending-migration activation.

Only the exact active Core operation can pass its own pending-operation guard.
The context is private, not an SDK/API token or an approval grant. It expires at
the end of the awaited operation, including for late asynchronous continuations.
Unrelated operations remain blocked. Completion response loss quarantines the
current artifact and attempts exact-close cleanup; it does not invoke another
rollback after successful activation or leave an unconfirmed rollback ready.

At startup, Core compares the latest pointer with the recorded old/candidate
identities, quarantines and confirms closure before changing metadata. Before
activation, or after a recorded safe rollback decision, it restores previous
metadata/status. Normal startup subsequently validates and loads that artifact;
reconciliation itself never executes it. An entered activation with possible
DB changes instead retains the candidate in error, records `review_required`,
and closes the intent after cleanup is confirmed. This is a reconciled failure,
not a successful upgrade. A fresh authorized Host action can retry the candidate
through existing lifecycle and migration-approval checks. Core does not replay
stored approval automatically, retry unknown side effects, downgrade a changed
schema or automatically restore a whole Host backup.

Unknown package identity, missing rows, failed status writes or unconfirmed
closure preserve the journal and both artifacts. The Workspace lane independently
checks pending-operation admission, including cached workers. A known pending
intent retires its owned worker; an unreadable journal denies new calls while
retaining ownership rather than recording a fictional close.

## Approved-upgrade verification

- Upgrade recovery14/14 plus existing upgrade-safety17/17 and cleanup3/3 passed
  in one selected run (34/34). Cases include ambiguous commit/completion,
  migration-entry review, rollback marker persistence failure, failed cleanup,
  changed pointers and stale recovery scans.
- Real PostgreSQL13/13 and existing removal recovery11/11 passed in a serialized
  selected run (24/24), including fresh initialization/all migrations, actual
  client reconnects, expiring private contexts, phase ordering, rollback markers
  and restore cancellation. No tests were skipped and owned cleanup succeeded.
- Workspace worker21/21 passed, including pending-operation admission, cached
  worker retirement and ownership retention when journal reads fail.
- Final server typecheck and SPS compatibility boundary check passed.

The first concurrent PostgreSQL run exceeded its unchanged90second setup
allowance and skipped all13 test bodies. It is not counted as passing evidence.
The serialized run above passed with the same90second setup,30second cleanup
and assertion limits. Test allowances do not alter product deadlines. Current
candidate CI is recorded with the candidate review; these local results alone
do not certify installed-app behavior.

## Removal increment verification (committed baseline)

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
