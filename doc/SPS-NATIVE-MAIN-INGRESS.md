# Native registration through Desktop Main

Status: source integration; full LAN and release qualification remain pending.

Core owns Identity sessions, pairing quotas/attempts, issuance records, pending
devices, transaction authorization and audit. Desktop Main owns TLS and the
protected Host server/issuer private keys. Plugins and AI Agents are not needed.

Prepared direct-owned startup requires both `SPS_NATIVE_HOST_MANAGEMENT=1` and
`SPS_NATIVE_PARENT_INGRESS=1`, a current signer channel and matching Host/server/
issuer pins. The dispatcher shares the inherited Node IPC descriptor with the
separate purpose-bound signer protocol. It accepts only version 1 envelopes in
the `sps.native.parent-ingress.*` namespace, bounded unique UUIDs, two unsettled
requests and 4096 accepted requests per instance. Closing the channel retires
the instance; there is no attachment to an external or replacement Host.

| Operation | Main-derived TLS evidence | Other credential |
| --- | --- | --- |
| `identity` | Fresh TLS 1.3, no client certificate | None |
| `session.exchange` | Fresh TLS 1.3, no client certificate | SPS Identity JWT |
| `enrollment.issue` | Fresh TLS 1.3, no client certificate | Current Identity cookie and pairing/CSR |
| `enrollment.complete` | Fresh TLS 1.3, exact authorized client leaf DER | Current Identity cookie and pairing/enrollment |
| `enrollment.reconcile` | Fresh TLS 1.3, exact authorized client leaf DER | Current Identity cookie and enrollment UUID |
| `enrollment.renew` | Fresh TLS 1.3, exact currently valid authorized client leaf DER | Current Identity cookie and same-key renewal CSR |

The envelope's `request` contains only exact `body`, `transport` and, when
required, `credential` slots. Main obtains transport evidence from its real TLS
socket, never HTTP headers or JSON. Core validates the closed envelope and
keeps copied peer DER in a private WeakMap proof. Ordinary HTTP factories still
require a real `TLSSocket`; a body-selected object cannot replace it. Main's
assertion is trusted within the existing same-user boundary, not proof against
a compromised Main process or an OS sandbox for Core/Plugins.

Core derives each user from the real Identity session and reauthorizes within
transactions. Main's proof is not user authentication, approval, membership or
execution permission. Completion projects only `{deviceId,status}` from the
stored device DTO. Reconcile reads the already committed device and does not
consume an invitation, issue a new certificate or add grants.

Renewal is a separate explicit operation for an already approved Member device.
The request contains only the existing device-key UUID and a CSR signed by that
same protected key; Main supplies the current Identity cookie and the exact
current TLS peer. Core verifies the live session and approved device in a bounded
transaction, matches the predecessor certificate and CSR public key to the
device's existing SPKI, and signs only while both the predecessor leaf and issuer
are currently valid. Renewal opens when the predecessor has at most the smaller
of 30 days or one third of its original lifetime remaining. It cannot renew an
expired leaf or change the device key, Host, issuer or approval state. Each new
leaf is recorded as an append-only renewal for the same device; it does not
replay an invitation or create new Workspace/Node/Plugin grants. A repeated
request for the same predecessor, account and CSR can return the committed
renewal, while a different CSR for that predecessor is rejected.

Desktop Main exposes renewal from the Native Member settings flow only after a
certificate inspection and explicit user confirmation. It validates the
returned leaf against the existing key and issuer, then publishes it through a
Windows safeStorage-encrypted renewal capsule with the prior credential context
checked before commit. Private keys, certificates and the session cookie stay
in Main. This is not an SPS Plugin SDK operation: `runtime.connectivity.current()`
remains a read-only, invocation-scoped connectivity snapshot and carries no
certificate or renewal authority. Expired Member credentials require a separate
re-enrollment path; renewal is not retried automatically.

Cancellation fences future work and delivery. Timed-out/aborted operations
retain capacity until they actually settle. Loss after commit does not undo
committed state; the existing persisted key/certificate recovery path handles
an unavailable completion result. No automatic enrollment retry is added.

Local `/api/sps/native-pairings` GET/POST and `/:pairingId/revoke` POST require
trusted loopback Desktop Owner proof plus the real startup-bound Owner session.
Mutation bodies are exactly `{}`; the first POST returns a one-time secret to
Main only. Policy is one hour, five incorrect secrets and ten active invitations.
List/revoke retain the existing redacted projections. Device approval and all
Workspace/Plugin/Node/Source grants remain separate.

No migration or public SDK change is required. Rollback consists of stopping
the Desktop registration listener and disabling the new parent-ingress flag;
existing data, device state, audit, local HTTP and Tailscale remain intact.
Already-issued invitations/devices do not become approved through rollback.

Focused route/protocol/constructor tests and real temporary DB enrollment are
available under `server/src/__tests__/sps-native-*`. SPS-Source adds a required
real child-process + Main TLS/signing + persisted Member recovery smoke. These
do not establish DPAPI UI composition, physical Host/Member/Node LAN, renewal,
full Native API/WS/resource coverage, signed updates, or all release gates.
