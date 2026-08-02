import { describe, expect, it } from "vitest";
import { SpsNodeExecutionUnavailableError } from "./sps-node-execution.js";
import {
  assertSpsNodeBindingRequiredForAdapter,
  createMarketplaceAssistantExternalTools,
  markMarketplaceAssistantNodeRuntime,
} from "./heartbeat.js";

describe("SPS Hub Node-only execution policy", () => {
  it("requires an approved primary Desktop Node for a local CLI adapter", () => {
    expect(() => assertSpsNodeBindingRequiredForAdapter({
      requireSpsNodeExecution: true,
      adapterType: "codex_local",
      hasSpsNodeExecutionTarget: false,
    })).toThrow(SpsNodeExecutionUnavailableError);
  });

  it("uses only Node-local runtime variables for a remote Marketplace MCP server", () => {
    const tools = createMarketplaceAssistantExternalTools({
      apiBaseUrl: "https://host.example/api",
      scopedToken: "scoped-token",
      runId: "run-1",
      companyId: "company-1",
      remoteNode: true,
    });
    const server = tools.mcpServers[0];

    expect(server.command).toBe("node.exe");
    expect(server.args).toContain("--input-type=module");
    expect(server.args.join(" ")).toContain("pathToFileURL(process.env.SPS_MARKETPLACE_MCP_ENTRY)");
    expect(server.args.join(" ")).not.toContain("@sps/mcp-server");
    expect(server.args).not.toContain(process.execPath);
    expect(server.env).toContainEqual({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    expect(server.revision).toBe("3-node-local-runtime");
  });

  it("marks only a remote Marketplace Assistant command for Node-local MCP materialization", () => {
    const original = { env: { EXISTING: "yes" }, model: "test" };
    expect(markMarketplaceAssistantNodeRuntime(original, true)).toEqual({
      env: { EXISTING: "yes", SPS_MARKETPLACE_MCP_REQUIRED: "1" },
      model: "test",
    });
    expect(markMarketplaceAssistantNodeRuntime(original, false)).toBe(original);
  });

  it("allows a local CLI adapter when the approved Node target exists", () => {
    expect(() => assertSpsNodeBindingRequiredForAdapter({
      requireSpsNodeExecution: true,
      adapterType: "sps_ollama_local",
      hasSpsNodeExecutionTarget: true,
    })).not.toThrow();
  });

  it("does not block API adapters that do not execute a local runtime", () => {
    expect(() => assertSpsNodeBindingRequiredForAdapter({
      requireSpsNodeExecution: true,
      adapterType: "http",
      hasSpsNodeExecutionTarget: false,
    })).not.toThrow();
  });

  it("keeps local development behavior when the Hub policy is disabled", () => {
    expect(() => assertSpsNodeBindingRequiredForAdapter({
      requireSpsNodeExecution: false,
      adapterType: "codex_local",
      hasSpsNodeExecutionTarget: false,
    })).not.toThrow();
  });
});
