# Per-Run Plugin Session Restrictions

Development contract, 2026-11-02. This is not an OS sandbox certificate or a
claim of successful provider execution.

`agents.sessions.describePolicySupport` uses `agent.sessions.read` and the
existing authenticated Workspace invocation. It returns schema version 1,
`modes: []` or `["plugin-tools-only-v1"]`, `enforcement: "dispatch-and-run"`,
`readiness: "unknown"`, and `osIsolation: "not-certified"`. It reads only
session ownership and routing configuration, not credentials or CLI health.

The optional `sendMessage.executionPolicy` is exactly:

```json
{"mode":"plugin-tools-only-v1","toolNames":["example.read","example.record"]}
```

One to 32 unique raw tool names are copied, validated and ASCII-sorted. A durable
request UUID is mandatory. Missing policy preserves the existing API; malformed
policy never means unrestricted execution. The policy is included in a versioned
durable request digest. Existing unrestricted request digests stay unchanged.
Restricted recovery revalidates the scheduler run's policy, message and reason;
uncertain admission is read, never automatically resent.

The initial implementation accepts only local `codex_local` CLI execution and
invocation-bound Workspace plugin tools declared by that plugin. Remote/Node
routing, legacy Host-worker tool execution, custom commands and custom CLI
arguments are rejected. Dispatch configuration support is not a live probe:
the adapter rechecks the actual runtime before executing it.

The adapter uses a copied, per-run read-only CLI configuration, ignores user
configuration/rules, disables the listed command/web/app/plugin/other execution
features, and injects only the Core session MCP bridge. It does not change the
stored Agent configuration or an account. Additional MCP approval overrides are
not enabled by this change. The CLI and its flags still require actual execution
qualification; read-only permissions alone are not a universal filesystem or
network isolation guarantee.

Core derives the policy from the persisted live run, never request-body claims.
Discovery and execution filter the allowed plugin tools. Workspace invocation
checks revalidate run/session, cancellation, activation, tool registry, access and
the unchanged policy before subsequent Host calls. Caller-selected project
context cannot bypass the restricted session scope. Stored session metadata
cannot replace Core-owned conversation identity, prompt or policy.

No workflow role, approval interpretation, task assignment, memory strategy,
automatic provider retry, new DB table or schema migration is introduced.

## Verification

Node 24.22.1: 12 targeted Vitest files, 206 tests passed. These include real
temporary PostgreSQL Host-service admission/recovery and mocked scheduler
responses, SDK RPC plumbing, policy input bounds, adapter configuration, tool
HTTP authorization and Workspace invocation revocation. The scheduler is mocked
in the DB suite: these tests do not launch a provider or demonstrate OS isolation.
SDK build, server typecheck and Codex adapter typecheck passed. No actual app,
real Lead/CTO execution, two-PC test, installation or Stable qualification is
established by these results.

Reference: [Codex non-interactive permissions](https://learn.chatgpt.com/docs/non-interactive-mode#permissions-and-safety).
