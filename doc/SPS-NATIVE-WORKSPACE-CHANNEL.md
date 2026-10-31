# Native Workspace channel foundation

This source increment provides private request authentication, a Core loopback
HTTP adapter, and a gated child-IPC startup composition. Core mounts it only for
a directly owned child with prepared Host management, the existing parent
ingress, and `SPS_NATIVE_WORKSPACE_CHANNEL=1`. The matching Main client must be
present before that flag is set. This is not full Native Workspace, asset,
WebSocket, Plugin, Source or Node access. Main still owns TLS and private keys.
The existing enrollment IPC protocol and ordinary Core HTTP listener remain
separate.

## Proof and authorization

Main and Core share a fresh 32-byte child-launch secret privately. The encoded
proof is base64url of a canonical JSON array, a dot, and base64url HMAC-SHA256 of
the decoded array bytes. Ordered fields are version 1, Host UUID, Workspace UUID
(or null for the exact discovery request below),
method, exact origin-form target, fresh 32-byte nonce, timestamp in milliseconds,
body SHA-256, exact Identity cookie, content type and client certificate DER.
Headers are capped at 8 KiB, body bytes at 64 KiB, target at 2 KiB and DER at
4 KiB. Caller options and request records reject extra fields and accessors.

Core binds the proof to actual received bytes and the configured Host, validates
current clientAuth-only leaf purpose and validity, rejects stale/future proofs,
and keeps at most 4,096 nonces without evicting live entries to admit a replay.
Disposal clears the copied secret and invalidates subsequent calls. A proof is
transport evidence from the owned Main, not user/device/Workspace authorization.
Main must obtain the certificate from actual authorized fresh TLS 1.3; supplying
DER to a signer does not establish that handshake. Core sends one exact
`sps.native.workspace.bootstrap.request` with a fresh UUID and the configured
Host/server/issuer pins. Main returns one same-ID `bootstrap.response` with the
same pins and a fresh 32-byte Base64URL key, or a fixed unavailable code. Core
validates the exact response, starts the loopback server, then sends a same-ID
`bootstrap.ready` containing the pins and bound `127.0.0.1` port. Main retains
the key and port only for that owned child and current Host generation. The
exchange has a 10-second bound, accepts one bootstrap, and does not rebind after
close or failure. A matching `bootstrap.close`, parent disconnect, child exit,
or stale Host/issuer guard disposes the server and verifier. The secret never
enters argv, environment, renderer, public HTTP or logs.

The proof codec permits a null Workspace binding only for the exact private
`GET /sps-native/v1/workspaces` discovery target. Core resolves the real Identity
session first, then in one bounded transaction locks the matching approved,
currently valid Host device and returns at most 200 active Workspace
`{id,name}` choices joined to that session user's active memberships. A valid
device with no active memberships receives an empty list; no matching device,
expired session, revoked membership or revoked device fails closed. More than
200 choices fails rather than returning a partial list. The listing conveys no
Workspace authority: each later surface request still binds its selected
Workspace ID and rechecks session, device and membership in that request's
transaction. Company-wide listing and Owner/Board fallback are not used.

After a Member selects a discovered Workspace, the private reader also accepts
only `GET /api/companies/<workspace-id>/workspace-bootstrap`. It returns the
selected Workspace's database-backed `{id,name,issuePrefix}`, the authenticated
Identity `userId`, and the fixed capability names `workspace.shell.read`,
`workspace.dashboard.read`, and `workspace.inbox.read`. The company row is read
inside the same transaction after the matching device, Workspace and active
membership are authorized; session and device authority are rechecked before
return. The response contains no Host, device, certificate, session, Owner or
Board credential. The three read capabilities describe mounted Core read
surfaces; they do not grant Plugin, mutation, WebSocket, Host-administration or
Source/Node authority. `issuePrefix` is bootstrap metadata only and does not
authorize routes. An active member/admin Workspace role also receives the exact
`workspace.inbox.state.write` capability; a viewer receives read capabilities
only. Core derives this capability from the locked current membership role.

The surface reader admits the exact workspace-discovery request above and five
Workspace-bound GET shapes: bootstrap metadata, shell, shell providers,
dashboard and inbox (only an optional archived=true/false query). It also
admits one exact `PATCH /api/companies/<workspace-id>/workspace-inbox/<item-id>`
with `Content-Type: application/json` and canonical UTF-8 JSON of at most 128
bytes containing only `read` and/or `archived` booleans. The state update calls
the existing Core Inbox service in the same authorized transaction and returns
only `{readAt,archivedAt}`. Viewers cannot mutate. Actions and arbitrary writes
remain unavailable. For Workspace requests it binds the path and proof Workspace
IDs, resolves the real Identity session, and rechecks that session and approved
device inside the same transaction as existing Core surface services. Shared
row locks keep device, active Workspace and active membership authority stable
through that transaction. Certificate validity and authority are checked again
before completion. SQL statement/lock deadlines are local to the transaction.
No actor, Owner bootstrap or legacy administrator fallback is used. Shell GET
retains the existing service behavior that can persist fallback metadata; it
is not a guarantee of a physically write-free read. That write remains inside
the authorized transaction and rolls back on a failed final check.

## Private HTTP adapter

The adapter binds only 127.0.0.1 with an ephemeral port. It delegates exact GET
targets and the one bounded Inbox PATCH target to the authenticated reader and
mounts no ordinary Core routes. Main
forwards only those same allowlisted origin-form targets over private HTTP, with
the actual Cookie, certificate DER and request target bound into the proof. It
rejects GET bodies, upgrade requests, duplicate relevant headers and Owner/Authorization
headers. Concurrency, header/socket/read budgets and JSON replies are bounded.
Replies are no-store and connections close after each request. Parent authority
is checked before admission and after reads; disposed or stale operations cannot
publish results. Disposal closes the listener/sockets and joins accepted reads,
failing if the join deadline expires. A response timeout cannot itself cancel an
arbitrary reader promise; full product composition must also bound Identity
resolution and transaction lifetime before enabling this path.

## Verification and remaining work

### Native mode in the existing Workspace build

The Core UI build now detects the dedicated Desktop Native preload and mounts a
capability-scoped entry in that same build. It reads the real bootstrap and
shell/dashboard/inbox through the fixed bridge; it does not mount ordinary Board
company bootstrap, Plugin initialization, ServiceWorker or live-update providers.
Neutral entry reuses the existing empty Workspace component. Plugin shell/views
are explicitly unavailable until their transport is authorized; Dashboard labels
describe configured declarations rather than claiming rendered Plugin widgets.
Inbox supports personal read/unread and archive/restore state only when the
fourth write capability is present. It awaits the mutation and refetches actual
Inbox data; Plugin actions and navigation targets remain inactive. Errors clear retained
names/content and obsolete request completions are ignored.

Eleven focused UI tests and the scoped UI build passed for the Inbox-state
increment. The two selected actual-DB checks (empty Inbox and personal state)
passed 2/2; HTTP adapter checks passed 8/8. These are scoped checks, not a new
full server suite/typecheck/build. The existing repository
token gate failed in unrelated files (79 color, 36 bracket-value, one font-size
violation); no new Native UI file was listed. Source's actual Electron/bundled UI
fixture passed window/IPC/isolation and natural shutdown with fixture backend;
it does not qualify installed real Host/Member access. Full workspace checks were
not repeated for this increment, following the requested focused workflow.

Focused proof tests passed 12/12, HTTP lifecycle/framing tests passed 7/7,
channel bootstrap/lifecycle tests passed 9/9, and actual temporary-DB/HTTP
surface tests passed 6/6, including the exact session-bound Workspace bootstrap
DTO and denial cases. Existing device tests plus transaction lock tests
passed 16/16. Source's real signer/verifier interoperability check uses generated
actual certificates and needs no DB or AI. Server typecheck is separate; full
current CI/build remain required before readiness claims. Source's actual Main
TLS, forked Core bootstrap and private HTTP integration also exited 0: generated
Member certificate, real session/device/membership and all four surfaces,
wrong-session/Workspace and revoked-device denial, no Agents/Plugins/Nodes, and
natural child/outer-process/database cleanup. This is source/loopback evidence,
not installed startup, protected Member storage, full UI or two-PC qualification.

Product qualification still requires protected Member credential/session access,
a confined per-window bridge,
actual SPA asset/API inventory, live-events and revocation socket composition,
renewal, real DPAPI and physical two-PC testing. These factories and narrow
surface reads do not substitute for that complete path. Rollback disables the
explicit new composition without a data migration; the ordinary Core listener
and existing access are unchanged.
