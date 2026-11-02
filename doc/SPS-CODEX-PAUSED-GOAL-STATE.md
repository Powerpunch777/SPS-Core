# Codex Paused Goal State Qualification

Date: 2026-11-02

Status: internal state validation and isolated no-model qualification. This is
not a selected production engine, SDK goal API, autonomous execution approval,
or proof of native child creation.

## Implemented

- `app-server-goal-state.ts` validates provider goal responses against an exact
  expected thread ID. Status, objective, accounting, timestamps and optional
  budget are bounded and returned frozen. Unknown protocol fields are omitted.
- The existing read-only client retains its original method allowlist. Its
  internal JSONL transport is reused by a separate state-probe client; that
  diagnostic permits thread creation/resume and goal get/set/clear, but rejects
  model turn requests and all server tools/approvals/auth-refresh requests.
- A goal write must explicitly be `paused`. Own data fields are copied into a
  new bounded object. Unknown fields, accessors and `toJSON` cannot change a
  checked paused write into an active one during serialization.
- `probe-codex-app-server-observer.mjs --paused-goal` creates a new empty local
  profile and workspace. It creates an idle non-ephemeral thread, verifies no
  previous goal, writes a paused objective, and confirms normal process exit.
  A second process uses the same temporary profile, reads the exact saved goal,
  resumes the same paused thread, rechecks accounting, clears the goal, and
  verifies it is null. Both processes must exit before owned-profile cleanup.

The state-probe client is only an internal diagnostic. Its caller must supply
a newly owned empty profile: resuming an ambient thread with an active goal
can itself start work. The probe checks that the restored goal is still paused
before resume. Do not expose this client as a generic plugin capability or use
it with an existing user's account home.

## Verification

With Node 24.22.1 from the Core root:

```powershell
pnpm exec vitest run packages/adapters/codex-local/src --exclude '**/dist/**'
pnpm --filter @paperclipai/adapter-codex-local typecheck
node scripts/probe-codex-app-server-observer.mjs <absolute-native-codex-executable>
node scripts/probe-codex-app-server-observer.mjs <absolute-native-codex-executable> --paused-goal
```

Adapter source checks: **204/204** passed, including 8 goal-response tests and
14 diagnostic goal-wire tests. Adapter typecheck passed. The state validator
also covers malformed Unicode, CRLF, nullable budgets, unknown statuses,
cross-thread identity, accessors, and unsafe numeric accounting.

Actual installed CLI **0.144.1** returned:

```json
{
  "schemaVersion": 1,
  "kind": "isolated-paused-goal-state-probe",
  "version": "0.144.1",
  "persistedAcrossProcessRestart": true,
  "sameThreadResumed": true,
  "clear": true,
  "observedTokensUsed": 0,
  "observedTimeUsedSeconds": 0,
  "clientTurnStartRequests": 0,
  "automaticContinuation": "not-tested",
  "realNativeChildExecution": "not-tested",
  "adapterActivated": false,
  "processesNormallyExited": 2
}
```

The counters describe observed goal accounting and client requests. This is not
an independent provider billing audit, signed attestation, or active-goal test.
The probe publishes no thread IDs, objective text, account data, home paths,
or raw provider diagnostics. It passes no existing credentials to the process.

## Required Before Product Integration

The official API describes persisted goal state. Inspection of the pinned
0.144.1 implementation additionally shows active goal updates can start a turn,
and resuming an active goal can trigger continuation. Those are mutating
execution operations, not harmless metadata reads. This diagnostic only tests
paused goals and does not validate that active continuation path.

Before any production goal activation/resume, reuse actual Core admission,
Workspace/plugin enablement and stop authority, exact scoped session identity,
permission checks, cancellation/recovery and quota handling. Do not automatically
resume every stored goal after restart, create replacement sessions, duplicate
CLI/app-server runs, or retry uncertain execution. An active provider goal does
not override revoked Core authority. Goal clear is not proof of process or
native-child termination.

The existing protected CLI still disables native multi-agent execution. Trusted
native child identity, separate Task Packet input/authority, parent-private-memory
boundaries, Worker/QA execution, history, cancellation, restart continuation and
workflow acceptance remain to be implemented and proven. Provider `complete`
is a provider status, not plugin business acceptance.

Core owns only neutral technical execution state. Builder owns its objectives,
roles, work allocation, specification and evaluation. The separate specification
Gate integration documents remain draft proposals; this increment does not
adopt or implement them. It does not expand Marketplace, Preview, LAN, Stable,
or overall Core completion scope, change dependencies, or update the installed app.

## Official References

- [App-server goal API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal)
- [Pinned goal runtime](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/ext/goal/src/runtime.rs)
- [Pinned goal request processor](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/app-server/src/request_processors/thread_goal_processor.rs)

No upstream implementation was copied and no new runtime dependency was added.
