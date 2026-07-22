# SPS MCP Server

Model Context Protocol server for SPS.

This package is a thin MCP wrapper over the existing SPS REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Authentication

The server reads its configuration from environment variables:

- `SPS_API_URL` - SPS base URL, for example `http://localhost:3100`
- `SPS_API_KEY` - bearer token used for `/api` requests
- `SPS_COMPANY_ID` - optional default company for company-scoped tools
- `SPS_AGENT_ID` - optional default agent for checkout helpers
- `SPS_RUN_ID` - optional run id forwarded on mutating requests
- `SPS_MCP_LEGACY_TOOL_NAMES` - optional `true` to retain `paperclip*` tool names during migration

The matching `PAPERCLIP_*` variables remain accepted as a temporary compatibility fallback. SPS variables always win when both are set.

## Usage

```sh
npx -y @sps/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @sps/mcp-server build
node packages/mcp-server/dist/stdio.js
```

## Tool Surface

Read tools:

- `spsMe`, `spsInboxLite`, `spsListAgents`, `spsGetAgent`
- `spsListIssues`, `spsGetIssue`, `spsGetHeartbeatContext`
- `spsListComments`, `spsGetComment`, `spsListIssueApprovals`
- `spsListDocuments`, `spsGetDocument`, `spsListDocumentRevisions`
- `spsListProjects`, `spsGetProject`, `spsGetIssueWorkspaceRuntime`
- `spsWaitForIssueWorkspaceService`, `spsListGoals`, `spsGetGoal`
- `spsListApprovals`, `spsGetApproval`, `spsGetApprovalIssues`, `spsListApprovalComments`

Write tools:

- `spsCreateIssue`, `spsUpdateIssue`, `spsCheckoutIssue`, `spsReleaseIssue`
- `spsAddComment`, `spsSuggestTasks`, `spsAskUserQuestions`, `spsRequestConfirmation`
- `spsUpsertIssueDocument`, `spsRestoreIssueDocumentRevision`, `spsControlIssueWorkspaceServices`
- `spsCreateApproval`, `spsLinkIssueApproval`, `spsUnlinkIssueApproval`
- `spsApprovalDecision`, `spsAddApprovalComment`

Escape hatch:

- `spsApiRequest`

`spsApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
