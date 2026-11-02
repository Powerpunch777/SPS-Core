# Codex Native Session Observation Increment

Date: 2026-11-02

Status: internal read-only transport and metadata validation, not an activated
execution engine, public SDK API, or native child execution qualification.

Follow-up: [paused goal state qualification](SPS-CODEX-PAUSED-GOAL-STATE.md)
reuses the internal transport in a separate empty-profile diagnostic. The
read-only client itself still cannot create threads, goals, or turns.

## Why This Exists

The separate Builder v15 workflow requires one persistent supervisor session
and independent native Codex child sessions. The existing protected CLI path
intentionally disables `multi_agent`. Enabling it without an actor boundary
would not prove independent memory or tool authority: native children can inherit
parent configuration and MCP access. Keep that restriction until the actual
child execution path has been qualified.

This Core increment contains no Lead, CTO, Worker, Task Packet, or business
completion model. It implements two internal technical pieces:

- `app-server-read-client.ts`: caller-owned stdio JSONL transport. A single
  initialization handshake enables only thread listing, metadata, turns, and
  item reads. It rejects server approvals, dynamic tool calls, auth refresh,
  and every other server request. It cannot create threads or model turns.
- `app-server-descendants.ts`: bounded, paginated direct-child observation.
  Every returned child must have the requested exact parent, valid thread IDs,
  and no duplicate identity. Only selected metadata is returned, frozen.

The transport has bounded frames, pending requests, and deadlines; malformed
UTF-8, responses, unknown IDs, and timeouts close it without retries. Error
messages do not echo provider payloads. It does not own or destroy its streams.
The caller owns process lifecycle and stream errors after detachment.

These helpers do not enforce tenant scope. They must not be exposed directly
to a plugin or used to read an ambient account's other threads. Production
integration still requires exact session ownership and invocation checks.

## Reproducible No-Model Probe

From this repository, with Node 24.22.1 and an explicit native Codex binary:

```powershell
node scripts/probe-codex-app-server-observer.mjs <absolute-native-codex-executable>
pnpm exec vitest run packages/adapters/codex-local/src --exclude '**/dist/**'
pnpm --filter @paperclipai/adapter-codex-local typecheck
```

The probe creates a new temporary home and workspace, passes no account
credentials, starts only a stdio app-server, initializes it, and lists direct
children of a fixed synthetic parent. It never sends `turn/start`. It waits for
normal process exit before removing only its verified owned temporary profile.
It publishes only a bounded version and aggregate result, not stderr, account
names, local paths, or thread logs. It does not select or replace an adapter.

Observed with installed Codex CLI **0.144.1**: initialization passed, direct
child filter accepted, zero children, zero model turns, process exit code zero.
The initial invocation used an unsupported top-level `--ignore-user-config`
flag and failed before initialization. The corrected probe relies on its newly
created empty `CODEX_HOME`; it does not copy the exec-only flag to app-server.

Final checks: **182/182** source adapter tests passed and adapter typecheck
passed. This includes **42** new transport/metadata tests. Two existing Windows
test assumptions were corrected: platform path separators and Windows process
termination reporting. The latter still checks the monitor's signal choice and
the disappearance of the real child PID. A first broad invocation included
generated `dist` tests and reported four failures, two duplicated Windows
assumptions; it is not recorded as a pass. Generated code was not rebuilt.

## Remaining Integration

1. Choose and qualify a single supported execution lane without launching the
   same operation through CLI and app-server.
2. Bind real native child creation, immutable child identity, and explicit input
   packets to the owning session. Observe actual children, not only empty lists.
3. Validate `item/tool/call` thread/turn identity before exposing any tool.
   A child must not act as its parent using inherited MCP credentials.
4. Prove independent child input/history and parent-private-memory exclusion.
5. Reuse existing Codex goals where supported. The locally generated 0.144.1
   schema includes `thread/goal/set`, `get`, and `clear`, and the official docs
   describe persisted TUI goal state. Schema presence does not prove automatic
   continuation, restart restoration, stop, quota, or cancellation behavior.
6. Connect durable restart/observation to the existing Core lifecycle. Current
   Workspace workers cannot subscribe to generic execution events or receive
   generic `runJob` dispatch directly. Do not claim those contracts exist or
   implement a parallel domain scheduler in Core.

Builder owns its objective, work allocation, decisions, QA, and completion.
Actual AI/native-child tests, app/UI acceptance, physical-device tests, and
release qualification remain separate and unproven by this increment.

## Official References

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): JSONL,
  initialization, experimental child filters, dynamic tool identity and goals.
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  native delegation and configuration/permission inheritance.
- [Node child process kill](https://nodejs.org/api/child_process.html#subprocesskillsignal):
  Windows termination semantics.

No upstream implementation was copied; no new dependencies or licenses were added.
