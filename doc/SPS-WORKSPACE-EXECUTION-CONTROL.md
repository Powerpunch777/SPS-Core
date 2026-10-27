# Workspace execution control

Core owns Workspace execution admission independently of Plugin workflow rules,
company budgets, archive state, Agent selection and network transport. A Plugin
cannot change this control through its ordinary SDK or Agent credentials.

## Durable policy

The additive `sps_workspace_execution_control` row is keyed by the existing
Workspace tenant (`company_id` internally). An absent row means the compatible
initial `running` state at epoch0. Operations initialize and lock this row before
locking run or execution-resource rows.

- **Pause:** close admission and claims for new/queued work. Existing active work
  may finish. Queued model tasks remain owned in memory and wait for resume.
- **Stop:** increment the decimal generation and close admission. In the same
  transaction, cancel queued runs/wakeups and record cancellation intent for
  active runs. Active Node/Plugin commands and jobs remain `cancelling`; model
  resource reservations remain pending until transport settlement. Agent runs
  retain their existing durable cancellation and termination markers.
- **Resume:** reopen admission at the current generation. Do not requeue any
  cancelled/interrupted execution. Retry/recovery generators must compare the
  originating run's epoch before creating work, so a delayed pre-stop callback
  cannot revive work after resume.

The control change and content-free activity event commit together. Repeated
stop can reconcile cancellation at the same generation. Every mutating request
includes the last observed revision; a stale screen receives409 and refreshes.
An independent company budget/archive policy remains enforced by its existing
path and by admission; resume does not change those policies.

Finalizing a run always releases its own issue/checkout references, including
after pause, stop, archive or an epoch change. Cleanup takes the control lock
first but does not require new admission. Recovery, deferred promotion and new
wakeups remain gated by active Workspace status, running control and the
originating epoch; releasing an old lock never revives execution.

## Execution lanes

Heartbeat enqueue/retry/recovery and claim gates, Node command creation, neutral
Plugin dispatch, Node/Plugin signed claim/lease/event/complete, Plugin Job
dispatch, and model submit/claim/pre-dispatch use the same tenant control.
Existing Native authority transactions remain authoritative; the admission
helper reuses them rather than substituting independent local flags.

Stop intent is durable before process-local cancellation fanout. Lane handlers
target only strictly older epochs. A delayed stop handler cannot cancel work
admitted after a subsequent stop/resume. Fanout is singleflight per lane,
Workspace and epoch, with a bounded HTTP join. Pending counts continue to report
unconfirmed termination; a returned stop request does not claim that every
process or external provider has stopped.

Node completion requires existing signed Node/device/session authority. A late
old-generation success report is accepted only as cancellation acknowledgement.
It cannot revive a run. Agent cancellation waits for signed completion receipts
for all sibling remote commands or the existing local-process termination path.
Failed local termination keeps its tracked handle.

The installed Plugin worker is shared Host-wide. A Workspace stop invalidates
only each affected invocation's authority and AbortSignal; it never terminates
the shared worker to stop one tenant. `cancelling` remains until an actual worker
response or worker-exit acknowledgement. Local RPC timeout suppresses result
delivery and fences later Host RPCs, but does not prove the Plugin handler ended.
Non-cooperative Plugin code may continue computing until runtime containment or
its real termination; it must remain visibly pending. OS process/file/network
isolation is separate unfinished work.

Host-scoped Plugin jobs are outside Workspace admission. An explicit direct
cancel of such a job still uses truthful cancellation/acknowledgement states.
Startup recovery does not automatically replay interrupted runs. A recovered
active job without termination evidence stays unconfirmed rather than being
called completed merely because the Host restarted.

Model stop aborts exact locally tracked transport tasks; resourcePending is not
cleared for dispatched work until transport settles. Queued undispatched model
rows can be cancelled under the same control lock used by claim. Provider effects
may remain unknown even after cancellation and must not be represented as undone.

## Host surface and permissions

`GET /api/companies/:companyId/execution-control` requires Board access to that
Workspace. `POST` additionally requires existing SPS Core Host authority; ordinary
Member, Agent and Plugin credentials are not administrators. The closed input
contains only action and expectedRevision. The UI is a Core-owned Workspace
settings section, available independently of AI and Plugin workflow surfaces.

The response distinguishes admission state, generation/revision, and pending
Agent/job/model/Node/Plugin counts. A stopped Workspace with unresolved execution
is displayed as waiting for termination confirmation. Read-only users have no
mutation controls. The initial integration targets the embedded Core settings;
it does not add general Native SDK administration or a new remote management
trust boundary.

The default SPS Host settings route mounts these controls. Native Member
Workspace entry uses its private, authenticated read surface to display a closed
snapshot with `canControl: false`; this grants no remote mutation authority.

## Compatibility, recovery and evidence

Migration0171 adds one control table and default0 epoch columns; existing run
rows and workflow meanings are retained. Plugin Job status adds `cancelling`;
consumers must accept this nonterminal state. Restore sanitization includes it
and preserves Workspace control policy. No destructive down migration or customer
data rewrite is required. An older Core does not enforce this new policy; do not
claim a downgrade preserves stopped admission without a compatible runtime gate.

See the Source review for exact revisions, focused checks and known failures.
This document describes implementation, not completed physical Windows LAN,
signed-installation, actual AI-provider or full release qualification. Marketplace
policy, Plugin Builder architecture and mandatory AI remain outside this change.
