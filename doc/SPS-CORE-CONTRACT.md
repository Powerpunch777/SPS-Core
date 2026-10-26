# SPS Core Contract

Status: current engineering contract

## Goal

SPS Core is the durable, workflow-neutral runtime embedded by SPS Desktop. A
user can enable different workflow plugins without replacing the identity,
storage, execution, safety, recovery, or update foundations of the product.

The product is a customizable workstation foundation, including customer-specific
non-AI programs. Core remains private and the Plugin SDK public. AI, OpenClaw,
OCE and Agent registration are not mandatory. Current Windows/Tailscale access,
identity and recovery contracts remain unchanged by this direction.

### Native Member foundation and local Host management

Full Windows Native LAN is not yet qualified. Prepared, directly owned startup
can mount the private Main-ingress registration dispatcher, while Desktop Main
owns the separate per-launch opt-in TLS listener. The Host device registry,
transport helper and optional event-WebSocket guard do not yet provide complete
Native Workspace/Source/Node transport. See [Main ingress](SPS-NATIVE-MAIN-INGRESS.md).

Existing device-request routes require an authenticated user with current active Workspace
membership and create `pending` state only. The Host UUID is trusted constructor
configuration, never a request selector. Local management additionally requires
both per-launch Desktop proofs and a real session; API keys, implicit Board
access and legacy admin roles do not substitute for these proofs. The earlier
request routes remain only for explicit legacy composition with
`nativeConnectivityHostId`; product management does not expose them as enrollment.

Desktop can opt its directly owned Core child into local device management after
preparing its protected Host identity. The public Host ID/server pin come from
the owned Main IPC channel, not an HTTP selector. The current real SPS Identity
session must match the startup-bound Host owner (the private subject-to-user
Base64URL SHA-256 mapping), the board actor and both local Desktop proofs.
Status, bounded device/event reads and approve/revoke are available without a
Workspace, Agent or Plugin. Reads and writes recheck the exact session inside
their DB transaction; parent-channel loss/disposal also fences final projections.
No Authorization token, legacy role or matching non-Owner session substitutes
for this authority. Preparing keys requires an explicit Host restart to mount
management; a lost channel is not silently rebound. Core opens no external Native
TLS socket; the separately gated Workspace channel uses private loopback HTTP.
Desktop can separately opt into registration and local Owner invitation actions;
these grant no Workspace/Node/Source access.

The directly owned Core process also has a bounded stop-only control path,
independently of Native signing. An explicitly marked inherited pipe is mounted
only with an existing direct parent IPC connection; its exact fixed command is
accepted once, at EOF. Desktop revokes signing authority and disconnects Native
IPC before requesting the existing Core drain and embedded-database shutdown.
The separate pipe remains usable after that revocation, but never reconnects
Native authority. Ordinary invalidation does not stop the Host. No HTTP, Plugin
or SDK shutdown endpoint is added. A sent request is not process-exit or
database-cleanup evidence; Desktop retains its bounded owned-process termination
fallback, and acceptance tests separately require process and temporary-data
cleanup. A parent connection already lost before mounting the pipe still uses
the existing bounded fallback; startup interruption is not graceful-stop proof.

Normal Core shutdown stops plugin scheduling and development discovery before
closing worker admission. It joins in-flight plugin startup and owned worker
termination before disposing Host services or stopping the embedded database.
The terminal worker-manager shutdown is shared by concurrent callers and rejects
new starts, including starts through previously returned managed handles; the
existing reusable `stopAll` operation is not redefined as terminal shutdown.
A shutdown RPC acknowledgement alone is not process-exit evidence. A child still
alive after the bounded termination sequence makes shutdown fail, and Core exits
nonzero rather than recording a clean shutdown. This is local lifecycle control,
not physical two-PC, distributed cancellation, or arbitrary descendant proof.
The reusable bulk stop also joins current startup and temporarily rejects new
starts, then reopens admission after completion. Only the exact successfully
stopped handles are removed; failed handles remain tracked and reject the call.
An old handle removed by individual or bulk stop cannot later spawn an untracked
process. Initialization that finishes after a stop request cannot publish
`running` or `ready` again. These are technical lifecycle guards, not plugin
workflow cancellation or permission changes.

Approval/revocation and redacted audit events commit together. Certificate and
SPKI are immutable; a revoked key is terminal. Approval grants no Workspace
membership, Plugin permission, Agent/Node execution or Source access. Authority
joins current Workspace/user membership, device state and certificate validity.
The public metadata projection excludes stored certificate material. Restore
deletes device trust and retains non-authorizing event history with a nullable
device reference.

Registration is not private-key possession. `sps-member-transport` requires a
real authorized TLS 1.3 clientAuth peer, validates its certificate fingerprint
against current authority on every call, and fences admissions across revocation.
Tracked socket disposal is local process behavior, not distributed revocation
or reversal of previously accepted work. The current global admission fence
can also reject an unrelated in-flight lookup during a revocation.

The optional WebSocket guard is for a dedicated authenticated Native ingress,
not the existing local/Agent/Tailscale listener. It checks admission and resolves
the same user session plus current device authority before event delivery;
revocation/invalid sessions stop delivery. There is no product call site yet.
Host identity persistence, certificate issuance/key storage and a zero-Plugin
local management UI have separate source implementations in SPS-Source. Complete
HTTP/subresource/other-upgrade coverage, certificate renewal and physical two-PC
qualification remain required beyond the bounded registration ingress.
An explicitly constructed private loopback Workspace adapter, request-proof
codec, and child-IPC startup composition now have source-level DB/HTTP and
channel lifecycle tests for selected surface queries. Core mounts them only for
a directly owned child when prepared Host management, the existing parent
ingress, and `SPS_NATIVE_WORKSPACE_CHANNEL=1` are all present. The matching Main
channel must be deployed before enabling that flag. This does not make the
ordinary Core listener a Native ingress or provide full Workspace assets,
WebSockets, Plugin, Source or Node access. See
[private Workspace channel](SPS-NATIVE-WORKSPACE-CHANNEL.md) for
request/session/device transaction boundaries and remaining composition.
Do not enable an ordinary listener, broaden a bind or reuse Node credentials as
a shortcut. No Connection API is added to the public SDK in this increment.

The internal Native pairing store now provides one-use pending enrollment for a
verified first-time account with no Workspace membership. It stores only a scoped
256-bit secret digest and an optional verified-email digest, binds each invitation
to the configured Host/server SPKI, and serializes consumption plus pending-device
registration/events in one transaction. Wrong-secret budgets commit on failure;
wrong email targets do not spend the invited user's attempt budget. Replay,
expiry, wrong Host/pin, exhausted/revoked invitations and revoked devices fail
closed. Host issuance quotas serialize per Host; restore scrubs pairing state and
keeps non-authorizing event snapshots.

This store is not an authentication boundary: a live transport must authenticate
the session, validate key possession and supply the trusted Host identity before
calling it. A verified database user alone is not a session. Existing HTTP routes
still require membership; the storage primitive itself is not a public API.
Prepared Owner routes and the private Main-ingress adapter now compose it.
Certificate approval and membership/grants remain separate. Product target/TTL
defaults are any verified recipient and one hour, supplied by Desktop under D6;
Core callers must still provide explicit policy and a server pin.
A local `createSpsNativeHostPairings` composition derives the
issuer solely from the prepared Host management object's current Owner session.
It fixes the approved first invitation to one hour and any verified recipient;
attempt and active-invitation caps remain mandatory explicit constructor inputs,
not product defaults or request selectors. Existing storage issue/revoke and a
new guarded list form reauthorize before and after their transaction work,
including terminal revoke responses. In-transaction authority failure rolls back
writes and audit together. Authority loss after a successful commit instead
withholds the result with `native_pairing_result_unavailable`; it does not undo
the committed state, promise rollback or automatically retry. An undelivered
one-time secret is unrecoverable; that pending invitation occupies quota until
expiry or a later authorized revoke. Old trusted internal callers retain their optional-guard
behavior; the storage primitive alone still authenticates no session. Parent
channel loss also fences final projections, but these checks are not atomic with
COMMIT or proof of distributed logout. Prepared startup mounts Owner-only
invitation routes; the storage composition itself opens no listener, SDK method
or membership/execution grant.
The pin is captured per service instance, not checked against a persistent global
identity registry. Rotation must retire old instances/listeners; the storage test
does not prove global rotation or physical device authentication.

Migration `0167_absurd_loki` adds Host-private public enrollment issuance records,
with one unique cascading row per invitation. The
`spsNativeEnrollmentService` reuses the pairing transaction and wrong-secret
budget for two operations, without adding a route, RPC, SDK method or listener:

- `issue` reserves the exact Host/server/issuer pins, verified user, device-key ID
  and canonical CSR digest, but does not consume the invitation. It calls an
  injected trusted signer outside the transaction and publishes only the exact
  reserved row after rechecking the invitation. Main must validate the PKCS#10
  signature/profile/key binding; no CA private key belongs in this interface.
  The stored public leaf must match the configured issuer, identity, purpose and
  requested validity. A committed identical retry returns the same certificate;
  a different request conflicts. The record stores neither full CSR nor secret.
- `completeFromTlsPeer` requires a real authorized, non-resumed TLS 1.3 socket
  or a privately branded, immutable certificate proof from the owned Main IPC,
  the same verified account and the exact committed certificate fingerprint.
  It consumes the invitation and creates only `pending` device state plus audit
  in one transaction, rechecking peer and certificate expiry after async writes.
  Headers, body certificate fields or a plain socket cannot provide this proof.

Signing concurrency/timeout are explicit constructor limits (per service
instance); the timeout bounds signing, not an end-to-end database deadline.
A signer that ignores abort keeps its slot until it settles. Failed
or interrupted `signing` records do not automatically re-sign on restart; a fresh
invitation is required. Altered reserved bindings are not overwritten. Issuance
records are removed before pairings on restore; non-authorizing audit remains.
There is no automatic retention cleanup yet.

An explicit `createSpsNativeParentEnrollmentService` composition can obtain the
public Host/issuer identity and request purpose-bound issuance over the direct
owned Desktop Main-to-Core child IPC channel. No private key, account token,
filesystem path or general-purpose signature is part of that protocol. The
client has bounded pending requests, timeout, abort and disconnect handling;
dispose and channel loss fence new operations and final transactional writes.
Main independently checks the current local Host session, identity store and
account/Vault lifecycle generation before and after asynchronous signing. This
does not make the Core child untrusted-code isolation or establish a Member
session. Startup instantiates this composition only with prepared Host
management and the explicit `SPS_NATIVE_PARENT_INGRESS=1` capability.

These remain internal persistence/transport operations. The current user ID
comes from a real, revalidated SPS session in the private Main-ingress adapter;
the DB verified flag alone is insufficient.
An inactive session-enrollment adapter now derives the user from the configured
SPS Identity cookie, never a body or actor substitute. Its private transaction
authorizer binds exact session ID/digest/user/expiry and verified account, with
shared row locks and a matching expected user. It runs before invitation attempt
accounting and before final issuance/replay/completion projections. Local logout
and the transaction are ordered by those locks; central Google logout propagation
and validity through the wall-clock instant of COMMIT are not implied.

The adapter requires a real fresh TLS 1.3 IncomingMessage, POST/JSON and no
browser-origin metadata or Authorization header. This is not proof that an
arbitrary TLS caller is Desktop Main. It exposes neither a login route nor a
general API proxy and is not instantiated by product startup. A future dedicated
listener must own TLS/socket admission, client-side server pins, session exchange
and complete HTTP/file/WebSocket authority coverage.

An inactive dedicated HTTP request handler now composes this adapter, with only
two exact internal v1 enrollment paths. It accepts fresh TLS 1.3 POST requests,
one bounded Content-Length and strict compact JSON.stringify UTF-8 bodies;
transfer/content encoding, duplicate JSON keys, browser mutation metadata,
invalid UTF-8, extra fields and other routes are rejected. Request read, operation
deadline and concurrency limits are explicit constructor inputs, not silently
enabled product defaults. Capacity is per handler, not distributed or a TLS
connection/rate limit. Work that ignores cancellation retains its slot until it
settles. A request guard fences session authorizers before and after transaction
work and final delivery; timeout, disposal and socket loss suppress late results.
Reservations or already committed effects are not magically rolled back, nor is
the network deadline atomic with the instant of COMMIT. There is no automatic
retry or fresh invitation. Completion projects only device ID and pending state;
it grants no membership or execution rights. Responses are no-store and close
the connection, with fixed error codes and no raw failures or account metadata.
The handler opens no socket, mounts no product route and creates no login or
trust. Loopback HTTPS/temporary DB acceptance is not app enrollment, Native LAN
or physical two-PC qualification. The compact wire encoding is a new private v1
contract; existing Core APIs and Plugin SDK messages are unchanged.

An additional inactive session-exchange handler accepts one exact private v1
path over a fresh TLS 1.3 POST connection, before enrollment. Its only credential
is one bounded SPS Identity Bearer token; Cookie, browser metadata, proxy
credentials, encoded or nonempty bodies and ambiguous headers are rejected.
It reuses the same configured RSA/JWKS verifier, user mapping, hashed seven-day
session storage and logout as the existing Identity route, not a second token
broker or authentication database. User upsert and session insertion now share
one transaction in both callers. Request guards fence those writes and final
credential delivery; loss after COMMIT withholds the result but does not undo
the committed session. There is no automatic retry or new idempotency promise.
The existing hub cookie policy is unchanged. This TLS-only handler always sets
Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain; the token and profile are
never returned in JSON. It grants no pairing, device approval, membership,
Plugin capability, Node/CLI execution or Source access.

Read/operation/concurrency limits remain explicit, per-handler inputs. Timeout
or disposal cannot free an unsettled operation's slot or deliver a late cookie;
the future listener still needs socket admission and rate/resource budgets.
Server-side TLS does not prove that a caller is Desktop Main. The future Main
client must verify the invited certificate/pin on the actual credential-bearing
connection before sending any token. Loopback tests exercise that ordering with
an RSA-signed fixture token, not production Google OAuth or an active Main client.
The handler is unmounted: creating it opens no listener, supplies no browser
cookie jar and does not share existing hub cookies with a different origin.

Desktop's source registration path now connects Main TLS, the private IPC
dispatcher, issued-credential persistence and explicit enrollment/recovery UI.
The ordinary HTTP factories described here remain unmounted in Core startup;
their real-socket requirement is unchanged. Existing network listeners,
Tailscale, Workspace/Plugin/Node/CLI/Source permissions and public SDK are unchanged.

An inactive public-identity handler now accepts only an empty, fresh TLS 1.3
POST on `/sps-native/v1/identity`, before account/session enrollment. It obtains
Host UUID, server SPKI, Member issuer SPKI and the public issuer certificate from
an explicitly injected trusted inspector, not a request selector. It rejects
account/browser/proxy credential metadata, ambiguous framing and resumed TLS.
The actual local TLS certificate must match the inspected server pin; issuer
certificate/profile scope and current validity must agree with the inspected
Host/issuer pin. A future trusted composition can reuse the owned parent signer
inspector; product startup does not create or mount this handler.

Only those four public fields are returned, with no-store/close headers and no
cookie. It creates no session/user/device, consumes no invitation and grants no
Workspace/Plugin/Node/CLI/Source authority. Read/operation/concurrency bounds are
explicit; timeout, disposal, socket loss and a synchronous current-identity
guard suppress late results while unresolved inspection retains capacity. This
is public PKI metadata over an already authenticated Host connection, not a new
Identity provider, browser access grant or proof of an approved Member. Desktop
must verify the exact invited server on that connection and validate the issuer
certificate before creating pending-key context. No listener, OS trust, firewall
change or public SDK method is added.

After the user's D8 approval, the inactive enrollment service also offers
read-only reconciliation of a completion whose response was lost. The exact
`/sps-native/v1/enrollment/reconcile` path accepts only an enrollment UUID. The
existing session adapter derives the user from the current SPS session, never
from the body. The service requires an explicit in-transaction authorizer and
a real authorized, non-resumed TLS 1.3 peer with the exact committed leaf.

Reconciliation locks and verifies the same Host/server/issuer/user issuance,
consumed pairing and its live device/snapshot linkage, certificate DER/hash/SPKI
and dates. Session, peer, current identity and certificate validity are checked
again before delivery. The invitation may already be expired, but the actual
device and issuer certificates must still be current. It returns only the
existing device ID and pending/approved/revoked status; even revoked status
disclosure is limited to that exact account and issued TLS key. It grants no
Workspace access, approval, execution or renewal and cannot revive trust.

No invitation secret, issuance, consumption, approval, device write or new audit
event is used to repair this read. Missing/deleted or inconsistent linkage fails
closed, including after restore. A read response is a status observation, not
authorization for a subsequent request or proof against a revocation occurring
after its transaction. Existing two-operation adapters remain compatible; the
new HTTP path is unavailable unless its reconciliation method is explicitly
provided. Product listener/startup and Main persistence/UI remain separate work.

### Optional Execution Backends

Keep model requests, process/CLI execution, Agent sessions and privileged Agent
deployment/control as distinct contracts. Reuse existing Node runs, grants,
public SDK platform sessions and safe execution projections before adding APIs.
Do not introduce another universal workflow scheduler or require every backend
to implement every operation. Unsupported features fail explicitly; cancellation
acceptance is not process-termination evidence and a backend change is never an
automatic retry of unknown external effects.

The existing OpenClaw Gateway adapter is reusable source, not current Gateway
qualification. OCE is a planned optional external control plane; it does not own
SPS Workspace data, local Plugin lifecycle or local Vault/renderer protection.
SPS authorization and an external backend's resource authorization are separate
checks. Workspace IDs, local Source paths and external Namespace IDs must not
be treated as interchangeable authority.

A model-request broker now has an additive mock-first source implementation;
the OCE management credential broker remains a target. The retained internal
`secrets.resolve` interface returns a string in
its type contract, but its current handler fails closed until scoped bindings
are implemented. Do not enable it as a shortcut for Direct API or OCE work.

Stage 3a introduced the **Host-internal foundation** used by Stage 3b:
`sps-model-transport` performs one bounded, non-streaming Responses-compatible
text request at an exact Host-selected endpoint/model, with storage/background/
tools disabled. HTTPS is required except for an explicit Host opt-in to numeric
loopback HTTP (HTTP localhost is pinned to 127.0.0.1). It never follows redirects,
retries a request, infers a price, returns provider metadata/errors, or claims
that aborting the local request terminated upstream work or billing. The total
timeout and per-transport-instance concurrency bound include credential resolution. Work
that ignores abort keeps its slot until it and its cleanup settle, even after
the caller receives a timeout/cancellation; a permanently pending operation
keeps the transport busy. Configuration also limits the request/response buffer
budget multiplied by concurrency to 8 MiB. This is not a strict JavaScript heap
limit, a distributed limit or proof that cancelled upstream work stopped.

`sps-model-bound-transport` reuses encrypted company Secrets and the existing
Plugin-instance binding at `sps.models.<connection-uuid>.apiKey`. It checks the
Workspace, Plugin instance, purpose, exact binding and selected usable version,
and rechecks deletion/rebinding/latest rotation/version revocation after async
resolution, using one SQL statement snapshot for each selector/material check.
The key is passed only inside the Host and in the selected provider's Bearer
header, never returned to a Plugin or renderer. The result
projects only text/refusal, technical completion and validated reported tokens.
Missing usage is unknown, not zero. Exact credential echoes in projected text
are rejected; this is not protection against an approved malicious provider
transforming or disclosing credentials, nor JS memory-zeroization evidence.

Stage 3b adds `sps.models.list/submit/get/cancel`, with separate read, submit and
cancel capabilities. All require an authenticated Workspace invocation, current
Plugin activation/capabilities/dependencies, and an approved immutable Host
connection. Host-only management routes create endpoint/model/limit/Secret
references and approve or revoke per-Plugin grants. Endpoint/model/key-reference
changes require a new connection; disabling one revokes its grants. Reapproval
increments a revision and cannot restore output belonging to an older revision.
A binding alone is **not execution authority**. No raw-key RPC is enabled.

Model submissions persist a unique Workspace/Plugin request key and input hash
before HTTP effects. Plaintext input remains ephemeral; a restart never replays
it. The broker records technical state, the dispatched credential version,
reported tokens and a bounded projected result. Result content is owned stored
data, not a claim of encrypted result storage. Current grants, binding, Secret
and the used version are rechecked before delivery; revocation withholds text
without erasing known token usage. A repeated identical request key returns its
original run, not a new provider request. Different input conflicts.

Local cancellation, lease/restart recovery and cleanup accounting do not prove
upstream termination or billing cancellation. There is no automatic HTTP retry,
fallback or input replay. The read-to-dispatch interval is not atomic with the
network. Common history uses the separate `model_request` lane and labels the
model `configured`, not provider-reported; it never loads prompt/result content.
Prices remain unknown. Host settings now exposes the existing connection and
per-Plugin approval APIs at `/company/settings/instance/model-connections`.
The Core baseline also links the existing Secret management page; the model
page consumes only credential metadata. Ready, enabled Plugins must declare
`sps.models.submit` to appear as approval choices. Manifest metadata is not a
grant: the existing server checks remain authoritative. Saved configuration is
not provider readiness, and creating it does not start a model request or Agent.
Uncertain mutation responses require a fresh read before another change; writes
are not automatically repeated. AI remains optional. Source
acceptance uses fake credentials and a loopback HTTP mock, not a real provider,
installed-app qualification, two-PC proof or production isolation certification.

The existing `sps.runtimes.list` projection may include an optional `connection`
for approved CLI Runner profiles. Its `executionOwner: "node"` and
`authorization: "execution_grant_required"` describe technical ownership, not
permission to start work. `state` is a cached Host observation: `recently_seen`
requires an active, key-verified Node and a valid, non-future heartbeat no older
than two minutes. Other states are `inactive`, `unverified`, `offline`, and
`unknown`. `observedAt` is the valid heartbeat timestamp, not a live probe.
Missing metadata from older Hosts is unknown. This does not certify a CLI login,
Runner availability, execution grant, model API, Agent session, or OCE backend.
The existing `online` field retains heartbeat-only liveness, independently of
approval; it may be true on a recently seen inactive Node. Missing, invalid or
future heartbeats never count as online. Existing credential/availability fields
remain separate; dispatch still checks
its grant and current Node/Runner/Source state. Discovery performs no execution,
credential read, or remote probe and checks both Node and Runner tenant IDs.

Worker initialization may include `spsHost: { contractVersion: "1.0", operations }`.
This is a snapshot of registered own Host handlers from a finite public Runtime
and Agent-session/model API list. It is generated again on Worker restart and contains
no tenant data, paths, provider configuration or secrets. It is deliberately
separate from the Worker callback `supportedMethods` returned to the Host.
Registration is not capability approval, Workspace activation, resource access,
credential availability, backend support or live health. Invocation checks remain
authoritative, including after permission or Node state changes. Older Hosts may
omit the snapshot; consumers must treat missing/unknown contracts as unknown,
not infer support from the SDK, Host version or JSON-RPC protocol version.
The current snapshot includes the four model methods. OCE control and secret
resolution remain absent. This is not complete backend capability negotiation.

`agents.describeExecution` is a separate bounded read under `agents.read`, not
a replacement for the retained compatibility `agents.list`/`get` shapes. It
selects only Agent ID/status/adapter identifier and the same-tenant Node binding
and cached observation. It does not load adapter/runtime config, paths, keys,
provider identity, prompts or command output. It reports registration separately
from configured/disabled state and always leaves execution readiness unknown.
Registration uses the existing adapter registry without imposing a new slug
grammar on external identifiers. Unknown, excessive, control-character, path or
URL-like display identifiers are masked; masking never changes registration.
`executionOwner: "adapter"` means routing is delegated to the existing adapter
and environment selection, not proof of a Host-local process. A bound Node is
reported only with same-tenant metadata; an inconsistent foreign Node becomes
an unknown observation without disclosing its ID. Every actual dispatch must
recheck Agent/Node/Runner/Source/resource authority. Inspection does not create
sessions, grants or runs or fall back to another backend. The internal fake
test harness explicitly does not model this new inspection operation.

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

Workspace Job invocations derive their tenant from the Host-provided
`job.companyId`. Nested Host calls cannot widen it to another Workspace.
Legacy Host-scoped Jobs omit that field and retain their explicit instance
invocation scope; this is not OS isolation or a Plugin workflow policy.

### Agent Defaults and CLI Accounts

Multiple Agents may use the same existing CLI login while retaining independent
runtime/model settings and default working folders. Shared provider accounts also
share their provider limits; Agent registration is not account provisioning or a
new quota. Explicit account/home/Node overrides retain their existing semantics.
The Assistant setup flow does not copy credentials from another Agent.

SPS Assistant create/edit surfaces expose the retained `adapterConfig.cwd` as a
default working folder. This is a fallback setting, not a replacement for an
authorized project/session workspace, a Source grant, or a filesystem sandbox.
Plugins assign workflow roles and may select an Agent; Core does not assign a
Lead/Worker role on registration. New neutral Assistant forms default unattended
permission/sandbox bypass off, including adapter switching. Existing saved Agent
settings are not silently rewritten.

Host Desktop may return an explicitly chosen local directory to this form; the
native picker neither saves Agent configuration nor starts a CLI. Builder may
request a minimized read-only comparison of a linked project and a selected
Agent's saved Codex-local cwd. A matching string does not certify actual runtime
cwd, file existence, login, authorization, sandbox containment or CLI availability.

### Plugin Session Tools

Local Plugin Agent conversations can receive an own-plugin stdio MCP bridge
through adapters that support external stdio tools. Core transports tool
discovery/execution; it does not decide when to delegate or what counts as a
successful workflow. The Codex CLI lane passes bound MCP environment values to
the child without embedding bearer tokens in command arguments or invocation
metadata. Existing sandbox, model, reasoning and approval settings are retained.

Projectless tool execution requires a run-bound Agent JWT, a running owned run,
an active owned plugin session, matching persisted conversation/task keys, and
the same tool-owning plugin. API keys, Board callers, closed/cancelling sessions
and other plugins cannot use this path. Workspace activation, explicit tool
grants and selected memory-provider checks still apply. The optional retained
`ToolRunContext.projectId` is not a new Core project requirement; ordinary
project-scoped calls retain their existing project authorization.

This local transport is not remote Node/SSH certification. Adapter support and
the current transport must be verified independently before claiming that a
workflow can delegate on every runtime.

## Plugin-Owned Contracts

Plugins own domain semantics, including:

- Room, Task, ticket, conversation, or other work-unit models.
- Lead, Worker, reviewer, approver, or other workflow roles.
- Assignment cardinality, status transitions, wake rules, and completion policy.
- Domain dashboards, inbox interpretation, navigation, forms, and artifacts.
- Memory summarization and retrieval strategy built on Core lifecycle/storage.

A bundled plugin may be enabled by default without becoming a Core invariant.

### Empty Workspaces and Native Recovery

A successfully loaded empty or terminated-only Agent list leaves the neutral
Workspace home usable; Agent registration is an explicit action, not an automatic
redirect. Existing Agent settings, APIs, deep links and plugin choices are retained.
In the SPS baseline (basic + Core baseline, not legacy Workplane mode), the
Workspace root without a selected usable Shell now renders an independent empty
entry, not the compatibility Layout, Agent directory or Dashboard. It queries
only the route Workspace's Shell selection. A selection/list error is an error
with explicit retry, never evidence of an empty Workspace; cached selections
must be revalidated before redirecting to Plugin UI.

The entry offers an explicit Plugin management link, without selecting, enabling,
installing or creating anything. Existing selected Shell manifests still open
their prior default route and compatibility chrome; missing/root-valued legacy
default routes fall back to the explicit Dashboard rather than a redirect loop.
Existing Dashboard, Inbox, Agent and settings deep links, data and APIs remain.
This does not yet implement standalone Plugin presentation, optional chrome for
selected Plugin pages, or the complete Primary/Extension manifest contract.
Default bundled-plugin choices are not silently rewritten.

Desktop's independent Native Core Settings stores the Host plugin recovery
preference outside the Core database. Saving the preference does not restart the
Host or change persisted plugin activation. An authorized local Host user must
separately confirm a restart to apply it. Core accepts
`SPS_PLUGIN_RECOVERY_MODE=all-disabled` at process startup; an invalid nonempty
value also blocks plugin code rather than enabling it.

Recovery startup suppresses plugin discovery, executable manifest imports,
installation/upgrade builds and migrations, worker loading, jobs, subscriptions,
tools, dev watchers and plugin UI assets. The plugin API retains authenticated
package status and explicit disable operations; blocked operations return
`plugin_recovery_active`. Saved package data and Workspace choices are not reset.
This is a recovery mechanism, not OS isolation, a global Workspace stop, a
replacement for authentication, or proof of remote process termination.

The approved future protected execution lane must reject unsupported plugins.
Legacy same-user execution may remain only as an explicitly selected temporary
trusted lane, never a silent fallback with protected-mode guarantees. That new
lane is not implemented by this recovery preference.

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
defaults); their raw ledger is unchanged. Old unmarked Agent-session records and
Node runs without a valid bound receipt remain unavailable. The separate neutral
Node ingestion contract below admits only validated Claude result reports. No
historical usage backfill, ledger replacement, provider
receipt reconciliation, budget enforcement or automatic business decisions are added here.
These are unreleased pinned-source additions, not features of the published SDK tag.

New Plugin Agent completions with usage also retain an internal
`sps.execution-usage-receipt/v1` in the existing execution row. The bounded receipt
binds Workspace, execution, Agent, Plugin and session IDs to the usage snapshot
with a deterministic SHA-256 digest. Receipt and terminal transition use the same
running-only conditional write: a repeated or late completion cannot overwrite
the accepted report. This is Core adapter-completion evidence, not a provider
signature, invoice, second ledger, or protection against a database administrator
rewriting both payload and digest.

History and summaries verify the receipt against persisted execution ownership.
A present but malformed, mismatched or altered receipt yields unknown usage;
unsealed sibling fields cannot override it. Rows without a receipt retain their
previous versioned-evidence behavior. No usage or an already-terminal cancelled
run may have no receipt; late provider usage is not recovered by this change.
This Agent-session receipt slice has no migration or old-row backfill.

### Neutral Plugin Node Claude Usage Ingestion

Neutral Node usage is accepted only from `claude_cli` structured JSON Lines result
records with `type: "result"` and a `modelUsage` object. The collector bounds a
line to 64 KiB and accepts 1 through 64 model entries. It reads only
`inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, and
`outputTokens`; for each aggregate, every model must provide a nonnegative safe
integer or that aggregate is null. `inputTokens` includes cache-creation input;
`cachedInputTokens` is the sum of cache reads. Valid token values are aggregated
across models, not exposed with model identifiers.

The last recognized result replaces the previous report; results are not
accumulated across lines. A recognized result with absent or invalid usage,
malformed JSON-like or truncated structured input, invalid UTF-8, or an oversized
line clears stale usage. Ordinary plaintext, unrelated CLI output, other
runtimes, and Claude top-level `usage` are not usage sources; plaintext does not
create or revise a report. No scope is inferred from arguments or output text.

The Node may add an optional strict `usageReport` to its signed completion. Its
versioned report has exactly `schemaVersion: 1`, source
`claude_model_usage_v1`, and the required nullable `inputTokens`,
`cachedInputTokens`, and `outputTokens` fields; at least one count must be
non-null. It uses no coercion or defaults. Older Nodes may omit it and older
Hosts strip the unknown field. This is not a public SDK method change.

The Host accepts a report only on a signed Node completion for the matching
Claude run. It revalidates current execution authority for a non-cancelling run.
It stores an internal
`sps.node-usage-receipt/v1` bound to Workspace, run, Node, runner, execution
grant, and Plugin, and writes the receipt with the terminal transition through
an active-state compare-and-set. Duplicate or late completion cannot overwrite
the accepted result. A cancellation that won first remains cancelled but may
retain the actual usage from its completion acknowledgement. Revocation that
made the run terminal does not append usage.

The receipt digest detects inconsistency in the Node application report. It is
not a provider signature or invoice, TPM/process-exit attestation, or defense
against an administrator rewriting both data and digest. Scoped history,
summaries, and Host usage UI use the bound receipt; an absent, malformed,
mismatched, or altered receipt yields unknown usage rather than falling back to
unbound fields.

Migration `0162_sps_node_usage` adds only nullable `usage_json`; existing rows
remain null and receive no backfill. Its generated snapshot reconciles the
existing hand-authored SPS migration baseline; the SQL migration itself only
adds the column. No second ledger, cost/model/billing/Agent attribution, budget,
admission, or reservation behavior is introduced. Codex and other runtimes
remain unknown: future support requires a separately reviewed, versioned source
contract, bounded parser, strict schema, and tests. This Claude report does not
authorize future Codex inference or budget enforcement.

Adapters may add `usageReportedFields` to distinguish real token fields from
parser defaults. Codex and Claude populate it from the actual selected CLI usage
event; missing or invalid fields stay unknown, including default zeroes. An
explicit reported zero is preserved. Omitted metadata retains legacy adapter
compatibility; malformed supplied metadata fails closed. This does not assert a
new per-run scope for a provider or alter inherited accounting/delta behavior.

`sps.executions.summarize` shares `sps.executions.read` and returns an own-Plugin,
Workspace-scoped projection over `createdAt` in `[from, to)`. Canonical UTC
millisecond bounds are required, at most 31 days. Lane and Agent filters are
optional; a neutral Node run has no Agent identity. Both lanes use one read-only
repeatable-read DB snapshot. More than 10,000 matching executions is rejected;
no truncated totals are presented as complete.

The projection counts each lane/run identity once and never appends charges on a
read. Reported and estimated token subtotals stay separate, with unavailable
coverage counts. API incremental cost, subscription reference cost and other cost
bases are never merged. All-unknown/empty subtotals are null; an explicit reported
zero is preserved. Overflow remains unknown rather than resetting a subtotal.
Durations sum recorded elapsed times, not wall-clock duration or process-exit
attestation. This is a live technical summary, not a provider invoice, immutable
usage receipt ledger or budget/reservation implementation. The summary projection
itself adds no migration or legacy cost-event rewrite; Node receipt storage is
the separate additive migration described above.

Host management can read this same projection through
`GET /api/companies/:companyId/sps-executions/summary`, with an installed registry
`pluginId` and the same window/filter options. Core resolves the Plugin key from
the registry; a supplied Plugin key cannot widen the query. Both local Host
authority and Workspace access are required. Member/Agent access stays on its
separate capability contracts. Disabled Plugin history remains readable while
its registry identity is retained. More than 10,000 rows returns 422 rather than
a partial success. Responses are not cached. The existing Plugin Settings Status
surface consumes this endpoint; no new navigation or workflow policy is added.

Host management also exposes read-only execution history through the existing
safe history service and DTO:

- `GET /api/companies/:companyId/sps-executions?pluginId=<registry UUID>` lists
  recent executions. `limit` defaults to 20 and must be 1..100. Optional `lane`
  is `node` or `agent_session`.
- `GET /api/companies/:companyId/sps-executions/:lane/:runId?pluginId=<registry UUID>`
  reads one scoped execution detail. `lane` is `node` or `agent_session`; `runId`
  is a UUID.

The list is ordered newest-first and paginates with the complete cursor tuple
`beforeCreatedAt` (UTC millisecond precision), `beforeRunId` (UUID), and
`beforeLane` (`node` or `agent_session`); cursor fields are supplied together.
The `pluginId` is the retained Plugin registry UUID, from which Core derives the
exact Plugin scope. Both local Host proof and Workspace access are required.
History for a disabled Plugin remains readable while its registry identity is
retained. These routes reuse the existing DTO and history service; they add no
schema, SDK method, ledger, or business policy.

The existing Plugin Settings > Status surface shows execution history below
usage, using the latest pages, explicit manual refresh, lane filtering, and
scoped detail. It adds no page or sidebar entry, polling, retry action,
cancellation mutation, or cascade policy. The UI does not show raw prompts,
arguments, environment, logs, raw errors, local paths, or arbitrary subject
labels. Technical `succeeded` is not business acceptance, and unknown usage is
not displayed as zero.

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

### Neutral Plugin Execution Timeout and Node Ownership Guards

Core validates an optional `timeoutMs` for neutral Plugin `dispatchRun` calls.
When supplied and non-null it must be a positive safe integer; zero, negative,
fractional, non-finite, unsafe, and non-number values are rejected before a run
is inserted. Accepted values are clamped to 1 second through 4 hours. An
omitted or null timeout remains unset; the Node applies its existing 30-minute
default. The Node independently validates and clamps supplied values for
neutral Plugin commands. Legacy Node commands retain their existing timeout
handling.

Before claiming a queued neutral Plugin run, Core validates the persisted
timeout again. A corrupted or otherwise invalid queued value marks that run
failed and claim processing skips it; invalid work is not sent to a process.
Neutral Plugin claims are never silently requeued after 10 minutes without
activity. Silence does not prove process termination: an old claim stays
claimed, and an explicit cancellation stays `cancelling`, until the signed Node
acknowledges completion. Uncertain process execution is not automatically
retried. The legacy command lane's existing stale-claim behavior is unchanged.

On the Local Node, an already-active command ID is rejected across all command
lanes before it can replace the tracked entry, spawn another process, or emit a
synthetic completion. Distinct IDs may execute concurrently; this identity guard
is not a shared concurrency budget. Existing lease, Workspace Source, and
authorization checks remain in force.

These guards add no migration, API or SDK method, global concurrency default,
or Workspace usage-budget enforcement. A configurable capacity limit and any
admission/reservation policy require a separate explicit contract; they are not
implied by timeout validation or duplicate-ID protection.

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
