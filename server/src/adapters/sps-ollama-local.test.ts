import { describe, expect, it, vi } from "vitest";
import type { AdapterSpsNodeRunner } from "@paperclipai/adapter-utils/execution-target";
import { executeSpsOllamaLocal } from "./sps-ollama-local.js";

describe("SPS Ollama Local adapter", () => {
  it("sends the prompt by stdin to Ollama on the assigned SPS Node", async () => {
    const runner = vi.fn(async (_input: Parameters<AdapterSpsNodeRunner["execute"]>[0]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Local model completed the task.",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }));

    const result = await executeSpsOllamaLocal({
      runId: "ollama-node-run",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Local Worker",
        adapterType: "sps_ollama_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "ollama", model: "qwen2.5-coder:7b" },
      context: { paperclipWorkspace: { cwd: process.cwd(), source: "project_primary" } },
      executionTarget: {
        kind: "remote",
        transport: "sps_node",
        nodeId: "node-1",
        nodeLabel: "Friend PC",
        projectId: "project-1",
        remoteCwd: "sps-project://project-1",
        runner: { execute: runner },
      },
      authToken: "hub-agent-token",
      onLog: async () => {},
    });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: "ollama",
      args: ["run", "qwen2.5-coder:7b"],
      cwd: "sps-project://project-1",
      env: expect.objectContaining({ PAPERCLIP_API_KEY: "hub-agent-token" }),
      stdin: expect.stringContaining("Local Worker"),
    }));
    expect(result.summary).toBe("Local model completed the task.");
    expect(result.provider).toBe("ollama");
  });
});
