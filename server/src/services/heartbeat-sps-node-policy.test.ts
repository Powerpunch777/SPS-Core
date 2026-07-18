import { describe, expect, it } from "vitest";
import { SpsNodeExecutionUnavailableError } from "./sps-node-execution.js";
import { assertSpsNodeBindingRequiredForAdapter } from "./heartbeat.js";

describe("SPS Hub Node-only execution policy", () => {
  it("requires an approved primary Desktop Node for a local CLI adapter", () => {
    expect(() => assertSpsNodeBindingRequiredForAdapter({
      requireSpsNodeExecution: true,
      adapterType: "codex_local",
      hasSpsNodeExecutionTarget: false,
    })).toThrow(SpsNodeExecutionUnavailableError);
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
