# Local MCP Desktop Node Bridge

## Current Position

SPS supports remote Streamable HTTP MCP through the first-party
`sps.mcp-connector` plugin. It intentionally does not turn an MCP server's
`command` field into a Hub-side shell command.

A local stdio MCP server belongs to the computer that owns its executable,
credentials, and project folder. SPS Desktop Node already enforces this model
for CLI runners: the Hub selects an approved runtime and a project, while the
Node validates the local executable and resolves the local workspace.

## Required Bridge Contract

Before local stdio MCP execution is enabled, the Desktop Node bridge must meet
all of these requirements:

1. The Node owner creates each server entry locally. The Hub stores only a
   stable server key, label, declared tool metadata, and authorization state.
   It never stores a command path, argument list, environment variable value,
   or credential.
2. A server entry has an exact local allowlist of executable basename and
   argument array. It must be spawned without a shell.
3. The Hub requests a named server key only. The Desktop Node resolves the
   actual process from local configuration and rejects unknown keys.
4. The request is bound to a company, project, agent, run, and Node command
   lease. The Node must reject an unapproved project workspace.
5. The MCP plugin must use `agentToolAccess: "explicit_grant"`. Core checks the
   Agent grant before dispatch and records only metadata in its tool audit.
6. Desktop Node forwards JSON-RPC over stdio with bounded request size,
   timeout, cancellation, process cleanup, and a server-specific tool
   allowlist. It must not forward raw environment variables or request payloads
   to the Hub audit log.
7. Server configuration changes, tool invocations, and denied requests are
   observable in an operator-facing audit without exposing tool arguments or
   returned secrets.

## Why This Is Not A Generic Shell Feature

An MCP `command` is executable code with the Desktop user's permissions.
Allowing a Hub or a plugin to submit arbitrary commands would bypass SPS Node's
approved CLI boundary. Until the above protocol is implemented end to end,
configure local MCP servers in the chosen local CLI's own approved MCP config,
or use the remote HTTPS connector.

## Implementation Order

1. Desktop-local encrypted server catalog and UI.
2. Signed Node protocol for server-key discovery and JSON-RPC request leasing.
3. Bounded stdio bridge with cancellation and per-server tool allowlists.
4. Core Node and Agent authorization checks plus payload-free audit.
5. Plugin settings UI and end-to-end tests on a second computer.
