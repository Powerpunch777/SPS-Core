# SPS Remote MCP Connector

This first-party SPS plugin connects to a remote **Streamable HTTP MCP** endpoint and exposes only explicitly allowlisted remote tools to SPS agents.

## Security model

- HTTPS is required, except for `localhost` development endpoints.
- `allowedToolNames` is an exact allowlist. Wildcards are rejected.
- Optional credentials are stored as SPS Secret References and resolved only for each connection.
- All outbound traffic travels through the SPS plugin HTTP capability.
- Dynamic Tool registrations are process-local and disappear automatically when this plugin stops or is disabled.
- Local `stdio` MCP servers are intentionally not supported here. They belong behind the approved SPS Desktop Node Bridge, so a Hub never runs arbitrary commands on a connected computer.

## Configuration

```json
{
  "serverUrl": "https://mcp.example.com/mcp",
  "bearerToken": "secret-ref://mcp-api-token",
  "allowedToolNames": ["search", "create_ticket"],
  "requestTimeoutMs": 30000
}
```

The remote tool `search` is exposed as `sps.mcp-connector:mcp_search` to SPS agents. The plugin never exposes tools that are absent from `allowedToolNames`.
