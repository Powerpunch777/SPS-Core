import { describe, expect, it } from "vitest";
import {
  insertCodexExternalToolArgs,
  mergeCodexExternalToolEnv,
  prepareCodexExternalTools,
} from "./codex-external-tools.js";

const secret = "very-secret-mcp-token";

function stdioServer(overrides: Record<string, unknown> = {}) {
  return {
    kind: "stdio",
    name: "local_mcp",
    command: "node",
    args: ["bridge.mjs", "--mode", "safe"],
    env: [{ name: "SPS_TEST_MCP_TOKEN", value: secret }],
    identity: "core.test",
    revision: "revision-1",
    ...overrides,
  };
}

describe("Codex CLI external MCP transport", () => {
  it("encodes stdio server config as TOML overrides and keeps secret values out of argv", () => {
    const prepared = prepareCodexExternalTools({ mcpServers: [stdioServer()] } as never);

    expect(prepared.args).toEqual([
      "-c",
      'mcp_servers.local_mcp.command="node"',
      "-c",
      'mcp_servers.local_mcp.args=["bridge.mjs", "--mode", "safe"]',
      "-c",
      'mcp_servers.local_mcp.env_vars=["SPS_TEST_MCP_TOKEN"]',
      "-c",
      "mcp_servers.local_mcp.enabled=true",
      "-c",
      "mcp_servers.local_mcp.startup_timeout_sec=30",
      "-c",
      "mcp_servers.local_mcp.required=true",
    ]);
    expect(prepared.env).toEqual({ SPS_TEST_MCP_TOKEN: secret });
    expect(JSON.stringify(prepared.args)).not.toContain(secret);
  });

  it("inserts config after existing CLI options and before the stdin prompt argument", () => {
    const existingArgs = [
      "--search",
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "-c",
      'service_tier="fast"',
      "-",
    ];
    const prepared = prepareCodexExternalTools({ mcpServers: [stdioServer()] } as never);

    expect(insertCodexExternalToolArgs(existingArgs, prepared.args)).toEqual([
      ...existingArgs.slice(0, -1),
      ...prepared.args,
      "-",
    ]);
  });

  it("rejects invalid names and control characters without echoing input", () => {
    expect(() => prepareCodexExternalTools({
      mcpServers: [stdioServer({ name: "bad.name" })],
    } as never)).toThrow("name is invalid");

    expect(() => prepareCodexExternalTools({
      mcpServers: [stdioServer({ command: "node\n--unsafe" })],
    } as never)).toThrow("command is invalid");

    expect(() => prepareCodexExternalTools({
      mcpServers: [stdioServer({ args: ["bad\u0000arg"] })],
    } as never)).toThrow("arguments are invalid");
  });

  it("rejects duplicate server names and conflicting environment bindings", () => {
    expect(() => prepareCodexExternalTools({
      mcpServers: [stdioServer(), stdioServer()],
    } as never)).toThrow("names must be unique");

    expect(() => prepareCodexExternalTools({
      mcpServers: [
        stdioServer(),
        stdioServer({
          name: "second_mcp",
          env: [{ name: "SPS_TEST_MCP_TOKEN", value: "different-secret" }],
        }),
      ],
    } as never)).toThrow("environment values conflict");
  });

  it("rejects unsupported transports instead of silently dropping them", () => {
    expect(() => prepareCodexExternalTools({
      mcpServers: [stdioServer({ kind: "http" })],
    } as never)).toThrow("only Core stdio MCP servers");
  });

  it("fails closed for remote CLI execution only when servers are requested", () => {
    expect(prepareCodexExternalTools({ mcpServers: [] }, true)).toEqual({ args: [], env: {} });
    expect(() => prepareCodexExternalTools({ mcpServers: [stdioServer()] } as never, true))
      .toThrow("not supported for remote execution");
  });

  it("rejects collisions with existing runtime environment variables", () => {
    expect(() => mergeCodexExternalToolEnv(
      { PATH: "existing-path" },
      { PATH: "replacement-path" },
    )).toThrow("conflicts with the runtime environment");
  });
});
