# Native Node execution contract

Native Node reuses the existing signed Node operations through a closed Main
transport. It is an opt-in development integration, not physical Windows LAN or
installed release qualification. SPS-Source owns Desktop integration and final
candidate evidence. AI and Plugins are not required to maintain the connection.

## Authority and wire boundary

The sole new target is POST `/sps-native/v1/node-runtime`, JSON with ordered
fields `{operation,nodeId,resourceId,payload}`. The request ceiling is 512 KiB
and response ceiling 1 MiB for this target only. Other Native surfaces retain
their existing budgets. Successful transport responses use `{data}` at HTTP
200; ordinary Node routes retain their existing statuses and response shapes.

Main owns actual TLS 1.3, pinned Host trust, Member keys and the session cookie.
The private Main proof binds the exact method, target, body, Workspace selector,
cookie and fresh TLS peer certificate. Core derives the user/device/Host from
that verified context and checks current session, approved device, certificate
and Workspace authority before and after its transaction. Renderer-supplied
identifiers and headers alone authorize nothing. No arbitrary HTTP proxy,
actor, path, socket, key or administrator API is exposed to Plugins.

The closed operations are register, heartbeat, availability, Source route,
command/Plugin-run claim, lease, output and completion. Registration additionally
proves possession of the Node Ed25519 key with domain
`SPS-NATIVE-NODE-REGISTER-V1`, bound to Host, Workspace, device, time, nonce and
the canonical raw registration hash. Other operations preserve existing signed
Node paths, nonce replay protection and payload signatures. Member TLS, Node
signing and RSA Source credential keys have separate roles.

Migration 0169 adds `sps_native_node_bindings`: one immutable device/Host/owner/
Workspace association per Node. Migration 0170 prevents physical device deletion
from silently deleting this binding while leaving an approved Node and its
grants available for transfer. Restore explicitly removes bindings before Node
and device trust. Existing rows gain no inferred Native binding or authority.
Same-device certificate renewal may continue after actual certificate authority
is checked; another device cannot take over the Node by presenting its own TLS
certificate and the same owner account. Device loss requires a new Node identity
and explicit Host approval, not grant copying.

## Execution and lifecycle

Native registration does not approve a Node, create execution grants, or grant
Source access. Host approval, current Agent/Plugin/runner/Source grants, lease
and output sequence remain required. Core runs no CLI or filesystem operation
inside the Native authorization transaction. Completion effects that require
the root DB are queued until commit. Authority loss after commit withholds the
response; it does not promise rollback or automatically retry the operation.

Same-key Native registration does not synchronize existing Agent grants onto
newly advertised runners. An existing runner key cannot change its runtime kind,
and the Source transport public key cannot change during that refresh. These
changes require an explicit new identity/approval path rather than reinterpreting
existing grants or encrypted credentials.

Native claims do not use the legacy ten-minute stale-claim requeue. Desktop
stops on ambiguous transport/action failure and requires explicit reconnection.
Reconnect uses the same protected Node identity to reconcile registration; it
does not replay an accepted command. Interrupted claimed work requires a
separate explicit resolution. Disconnecting the local controller is not a claim
that the Host revoked its Node approval or undid external effects.

Desktop joins exact owned command cleanup for disconnect, account change,
restore and shutdown. Cleanup failure must retain the handle, report unavailable
and block a replacement until cleanup succeeds. Long commands keep heartbeat
separate from their execution await. Recovery-only Desktop startup does not
automatically resume saved Nodes. Source work requires its approved Host route;
there is no fallback to a local Source root. General Agent/MCP calls are not
provided by this closed transport.

## Compatibility and rollback

`sps-node-operations` is shared with the ordinary HTTP wrappers, whose existing
session/owner checks, legacy response statuses and default runner reconciliation
remain. Native composition explicitly disables automatic runner grant creation.
This is additive schema/state; reverting to the earlier code must retain the
new tables and protected Desktop state rather than deleting user identities.
No automatic reverse migration or reinterpretation of older Node grants is
provided. Restoring a backup intentionally clears remote trust as before.

The source implementation and focused checks are not sufficient to qualify
arbitrary CLI sandboxing, real AI providers, SMB file access, production
Identity, two physical Windows computers, signed installation or update.
SPS-Source's Native Node review must record the exact passing and failed runs.
