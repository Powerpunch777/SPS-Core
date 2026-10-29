# SPS Node claim recovery

Status: opt-in server receipts, Node client transport and Desktop encrypted
claim/launch journaling implemented; final exact-tuple CI/Windows product
qualification remains required. This is Runner transport, not new Native
network development or plugin workflow policy.

## Wire contract and compatibility

The existing signed `POST /sps-nodes/:nodeId/commands/claim-next` and
`POST /sps-nodes/:nodeId/plugin-runs/claim-next` retain their task/empty-204
responses when `claimRequestId` is absent.

Opt in by adding a signed `claimRequestId` to the payload. Its canonical form
is `v1:<13-digit-creation-time-in-ms>:<lowercase-random-uuid-v4>`. It is distinct
from the signature nonce. Each retry uses the same request ID and payload with
a fresh signature timestamp and nonce. A different queue kind needs a different
request ID. The creation time may be at most five minutes ahead of server time.

An opt-in response always uses HTTP 200:

```json
{
  "schemaVersion": 1,
  "claimRequestId": "v1:1793246400000:32d7530b-e0a5-41f7-92ad-a70ba0aee352",
  "kind": "agent-command",
  "work": null
}
```

`kind` is `agent-command` or `plugin-run`; `work` is the existing claimed task
with its resolved runtime kind, or null. Null is itself a durable result. A
retry of that empty request must not consume work queued after the first
response. The client must validate the version, exact ID and kind. Legacy or
malformed responses fail without an automatic fallback claim.

## Persistence and authority

`sps_node_claim_receipts` stores Workspace/Node/request identity, queue kind,
request/result binding digest, execution epoch, optional immutable work ID and expiry.
It does not duplicate execution payloads or credential envelopes. Work IDs
deliberately have no task foreign key that could silently turn deleted work
into an empty receipt. Company/Node deletion cascades their own receipts.

The existing Workspace execution-control row lock serializes admission before
resource locks. A new work claim and its receipt, including a negative result,
commit in the same transaction. Concurrent equal requests see the same receipt.
Authority and runtime reads within admission use that same database transaction;
waiting concurrent admissions do not exhaust the SQL pool while the active
claim tries to acquire another connection for authorization.
Reusing an ID across kinds or with different signed input conflicts.
For a positive receipt, its digest also binds the exact JSON task payload and
resolved runtime returned by the first response. A later payload/runtime change
cannot silently replace that result; replay conflicts instead. Negative
receipts bind the input without retaining any task payload.

Replay requires a currently approved Node with the same key and Workspace,
current request authorization and execution epoch. Positive replay additionally
requires the exact scoped work to remain claimed with no output events, its
current grants and runtime to remain valid, and any parent Agent session to
remain active. Missing, reassigned, terminal, cancelled or otherwise ineligible
work is rejected; the service does not claim another row instead.

A receipt is neither a lease nor proof of execution or termination. The normal
lease check is still required at actual launch, including after receipt replay.
The retained claim-time `startedAt` field is not physical launch evidence.
Administrative cancellation and late completion-report rules are unchanged.

## Lifetime and cleanup

Receipt lifetime is 24 hours from the creation time encoded in the request ID;
retries do not extend it. The server checks expiry again after waiting for the
admission lock. Expired IDs fail even if their stored receipt has been removed,
so cleanup cannot silently resurrect an old request as new work. Expired rows
for the exact Workspace/Node are pruned when a new request is admitted.

The lifetime is an explicit recovery limit. Clients must retain and surface
expired unresolved work rather than invent a new ID, requeue work by age, or
pretend an uncertain execution never started. A Workspace stop/resume also
invalidates old captured epochs rather than transferring claim authority.

## Desktop integration

Desktop persists a claim intent under the
exact account, Host, Node and public-key identity, before the first request.
It persists the returned task binding before execution preparation, and an
execution-entry marker before the actual spawn boundary. On restart, it retries only
unentered requests using the original ID. Entered or uncertain executions must
never be automatically replayed. A crash between the entry marker and spawn can
remain uncertain; this protocol does not promise exactly-once execution.

Within one Desktop process, a separate owner fence covers preflight through
executor settlement. Reconnecting polls cannot prepare the same received work
concurrently, even before its durable spawn-entry marker. A stale poll may
record a not-started completion only after atomically marking its unowned,
unentered claim aborted. An aborted claim cannot be acquired for execution;
after a restart it resumes only its final report. This prevents an old delayed
response from falsely closing work which a replacement poll has already entered.

The existing encrypted completion outbox remains a separate final-result lane.
After confirmed closure and durable final-result persistence it can reconcile
the matching claim journal, including across a crash between the two writes.
Do not clear completion evidence before the journal can be reconciled. Storage
failure, corrupted journals, expired pending requests and unsupported Hosts must
stop new work safely and provide a truthful recovery status.

Desktop clients qualify Host support via signed `POST /sps-nodes/:nodeId/claim-protocol`
before enabling resumable polling. This read-only request returns version and
maximum recovery age without claiming work. Unsupported or malformed results
stop new claims without falling back to legacy behavior;
an old Host must not be probed by repeatedly issuing opt-in claims that it cannot
remember. Existing callers without the opt-in field remain compatible.

## Data changes

Migration `0176_sps_node_claim_receipts` adds one table, two indexes and scoped
Company/Node foreign keys. It does not alter existing task, secret or account
rows. A rollback to legacy polling loses the new recovery guarantee; pending
claim journals must be preserved and not replayed against a legacy Host.
