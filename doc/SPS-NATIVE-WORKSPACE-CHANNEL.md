# Native Workspace channel foundation

This source increment provides private request authentication and an explicitly
constructed Core loopback HTTP adapter. Product startup does not mount it yet.
It is not full Native Workspace, asset, WebSocket, Plugin, Source or Node access.
Main still owns TLS and private keys. The existing enrollment IPC protocol and
ordinary Core HTTP listener remain separate.

## Proof and authorization

Main and Core share a fresh 32-byte child-launch secret privately. The encoded
proof is base64url of a canonical JSON array, a dot, and base64url HMAC-SHA256 of
the decoded array bytes. Ordered fields are version 1, Host UUID, Workspace UUID,
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
DER to a signer does not establish that handshake. The secret must not enter
argv, environment, renderer, public HTTP or logs. Its actual private IPC startup
exchange, Host pin binding and lifecycle composition remain to be implemented.

The surface reader admits four exact GET families: Workspace shell/providers,
dashboard and inbox (only an optional archived=true/false query). It binds path
and proof Workspace IDs, resolves the real Identity session, and rechecks that
session and approved device inside the same transaction as existing Core surface
services. Shared row locks keep device, active Workspace and active membership
authority stable through that transaction. Certificate validity and authority
are checked again before completion. SQL statement/lock deadlines are local to
the transaction. No actor, Owner bootstrap or legacy administrator fallback is
used. Shell GET retains the existing service behavior that can persist fallback
metadata; it is not a guarantee of a physically write-free read. That write
remains inside the authorized transaction and rolls back on a failed final check.

## Private HTTP adapter

The adapter binds only 127.0.0.1 with an ephemeral port. It delegates exact GET
targets to the authenticated reader and mounts no ordinary Core routes. It
rejects bodies, upgrade requests, duplicate relevant headers and Owner/Authorization
headers. Concurrency, header/socket/read budgets and JSON replies are bounded.
Replies are no-store and connections close after each request. Parent authority
is checked before admission and after reads; disposed or stale operations cannot
publish results. Disposal closes the listener/sockets and joins accepted reads,
failing if the join deadline expires. A response timeout cannot itself cancel an
arbitrary reader promise; full product composition must also bound Identity
resolution and transaction lifetime before enabling this path.

## Verification and remaining work

Focused proof tests passed 11/11, HTTP lifecycle/framing tests passed 7/7, and
actual temporary-DB/HTTP surface tests passed 4/4. Existing device tests plus
transaction lock tests passed 16/16. Source's real signer/verifier interoperability
check uses generated actual certificates and needs no DB or AI. Server typecheck
is separate; full current CI/build remain required before readiness claims.

Product enablement still requires the private child secret/port startup exchange,
Main Host TLS forwarding, protected Member credential/session access, a confined
per-window bridge, actual SPA asset/API inventory, live-events and revocation
socket composition, renewal, real DPAPI and physical two-PC testing. These
factories and narrow surface reads do not substitute for that complete path.
Rollback removes the explicit new composition without a data migration; no
product listener is automatically opened and no existing access is broadened.
