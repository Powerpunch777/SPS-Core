export interface RemoteMcpTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MappedMcpTool extends RemoteMcpTool {
  spsToolName: string;
}

const MAX_TOOL_NAME_LENGTH = 80;

function stableSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function localName(remoteName: string): string {
  const normalized = remoteName.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  const base = `mcp_${normalized || "tool"}`;
  return base.slice(0, MAX_TOOL_NAME_LENGTH);
}

export function mapAllowedRemoteTools(
  remoteTools: RemoteMcpTool[],
  allowedToolNames: string[],
): MappedMcpTool[] {
  const allowed = new Set(allowedToolNames);
  const seen = new Set<string>();
  const mapped: MappedMcpTool[] = [];

  for (const remote of remoteTools) {
    if (!allowed.has(remote.name)) continue;
    let spsToolName = localName(remote.name);
    if (seen.has(spsToolName)) {
      const suffix = `_${stableSuffix(remote.name)}`;
      spsToolName = `${spsToolName.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
    }
    seen.add(spsToolName);
    mapped.push({ ...remote, spsToolName });
  }

  return mapped;
}

export function defaultInputSchema(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { type: "object", properties: {} };
}
