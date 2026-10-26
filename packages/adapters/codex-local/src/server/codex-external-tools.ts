import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const MAX_MCP_SERVERS = 32;
const MAX_ARGS_PER_SERVER = 128;
const MAX_ENV_PER_SERVER = 128;
const MAX_CONFIG_ARG_CHARS = 16_000;
const MAX_VALUE_CHARS = 8_192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface PreparedCodexExternalTools {
  args: string[];
  env: Record<string, string>;
}

const EMPTY_EXTERNAL_TOOLS: PreparedCodexExternalTools = { args: [], env: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, maxLength = MAX_VALUE_CHARS): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !CONTROL_CHARACTERS.test(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function createConfigArgs(
  name: string,
  command: string,
  args: readonly string[],
  envNames: readonly string[],
): string[] {
  return [
    "-c",
    `mcp_servers.${name}.command=${tomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${tomlArray(args)}`,
    "-c",
    `mcp_servers.${name}.env_vars=${tomlArray(envNames)}`,
    "-c",
    `mcp_servers.${name}.enabled=true`,
    "-c",
    `mcp_servers.${name}.startup_timeout_sec=30`,
    "-c",
    `mcp_servers.${name}.required=true`,
  ];
}

export function prepareCodexExternalTools(
  externalTools: AdapterExecutionContext["externalTools"],
  isRemoteExecution = false,
): PreparedCodexExternalTools {
  if (externalTools == null) return EMPTY_EXTERNAL_TOOLS;
  if (!isRecord(externalTools)) throw new Error("Core external tools configuration is invalid.");
  if (Object.keys(externalTools).some((key) => key !== "mcpServers")) {
    throw new Error("Core external tools configuration contains an unsupported field.");
  }

  const specsValue = externalTools.mcpServers;
  if (specsValue === undefined) return EMPTY_EXTERNAL_TOOLS;
  if (!Array.isArray(specsValue)) throw new Error("Core MCP server list is invalid.");
  if (specsValue.length === 0) return EMPTY_EXTERNAL_TOOLS;
  if (isRemoteExecution) {
    throw new Error("Codex CLI MCP servers are not supported for remote execution.");
  }
  if (specsValue.length > MAX_MCP_SERVERS) {
    throw new Error("At most 32 Core MCP servers may be injected into one Codex CLI run.");
  }

  const names = new Set<string>();
  const envValues = new Map<string, { name: string; value: string }>();
  const args: string[] = [];
  let configArgChars = 0;
  let envChars = 0;

  for (const value of specsValue) {
    if (!isRecord(value)) throw new Error("Core MCP server specification is invalid.");
    if (value.kind !== "stdio") throw new Error("Codex CLI supports only Core stdio MCP servers.");

    const { name, command, identity, revision } = value;
    if (typeof name !== "string" || !SERVER_NAME.test(name)) {
      throw new Error("Core MCP server name is invalid.");
    }
    if (names.has(name)) throw new Error("Core MCP server names must be unique.");
    names.add(name);

    if (!isSafeText(command)) throw new Error("Core MCP server command is invalid.");
    if (!isSafeText(identity) || !isSafeText(revision)) {
      throw new Error("Core MCP server identity is invalid.");
    }

    const serverArgs = value.args;
    if (!Array.isArray(serverArgs) || serverArgs.length > MAX_ARGS_PER_SERVER
      || serverArgs.some((arg) => typeof arg !== "string"
        || arg.length > MAX_VALUE_CHARS
        || CONTROL_CHARACTERS.test(arg))) {
      throw new Error("Core MCP server arguments are invalid.");
    }

    const serverEnv = value.env === undefined ? [] : value.env;
    if (!Array.isArray(serverEnv) || serverEnv.length > MAX_ENV_PER_SERVER) {
      throw new Error("Core MCP server environment is invalid.");
    }
    const localEnvNames = new Set<string>();
    const envNames: string[] = [];
    for (const entry of serverEnv) {
      if (!isRecord(entry) || typeof entry.name !== "string" || !ENV_NAME.test(entry.name)
        || typeof entry.value !== "string" || entry.value.includes("\u0000")
        || entry.value.length > MAX_VALUE_CHARS) {
        throw new Error("Core MCP server environment entry is invalid.");
      }
      const normalizedName = entry.name.toUpperCase();
      if (localEnvNames.has(normalizedName)) {
        throw new Error("Core MCP server environment names must be unique.");
      }
      localEnvNames.add(normalizedName);
      const previous = envValues.get(normalizedName);
      if (previous && previous.value !== entry.value) {
        throw new Error("Core MCP server environment values conflict.");
      }
      envValues.set(normalizedName, { name: entry.name, value: entry.value });
      envNames.push(entry.name);
      envChars += entry.name.length + entry.value.length;
    }

    const serverConfigArgs = createConfigArgs(name, command, serverArgs as string[], envNames);
    configArgChars += serverConfigArgs.reduce((total, arg) => total + arg.length, 0);
    args.push(...serverConfigArgs);
  }

  if (configArgChars > MAX_CONFIG_ARG_CHARS || envChars > MAX_CONFIG_ARG_CHARS) {
    throw new Error("Core MCP server configuration exceeds the Codex CLI size limit.");
  }

  return {
    args,
    env: Object.fromEntries([...envValues.values()].map(({ name, value }) => [name, value])),
  };
}

export function insertCodexExternalToolArgs(
  execArgs: readonly string[],
  externalToolArgs: readonly string[],
): string[] {
  if (externalToolArgs.length === 0) return [...execArgs];
  if (execArgs.at(-1) !== "-") {
    throw new Error("Codex CLI stdin prompt argument is missing.");
  }
  return [...execArgs.slice(0, -1), ...externalToolArgs, "-"];
}

export function mergeCodexExternalToolEnv(
  baseEnv: Record<string, string>,
  externalEnv: Record<string, string>,
): Record<string, string> {
  const merged = { ...baseEnv };
  const existingNames = new Map(
    Object.entries(baseEnv).map(([name, value]) => [name.toUpperCase(), { name, value }]),
  );

  for (const [name, value] of Object.entries(externalEnv)) {
    const existing = existingNames.get(name.toUpperCase());
    if (existing && (existing.name !== name || existing.value !== value)) {
      throw new Error("Core MCP server environment conflicts with the runtime environment.");
    }
    merged[name] = value;
  }

  return merged;
}
