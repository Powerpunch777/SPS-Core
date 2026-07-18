import { describe, expect, it, vi } from "vitest";
import type { AdapterSpsNodeRunner } from "@paperclipai/adapter-utils/execution-target";
import { executeSpsLmStudioLocal } from "./sps-lm-studio-local.js";

describe("SPS LM Studio Local adapter", () => {
  it("sends the task context by stdin to LM Studio on the assigned SPS Node", async () => {
    const runner = vi.fn(async (_input: Parameters<AdapterSpsNodeRunner["execute"]>[0]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "LM Studio completed the task.",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }));

    const result = await executeSpsLmStudioLocal({
      runId: "lm-studio-node-run",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Local Worker",
        adapterType: "sps_lm_studio_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "lms", model: "qwen3-4b", keepLoadedSec: 900 },
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
      command: "lms",
      args: [
        "chat",
        "qwen3-4b",
        "--prompt",
        "Read and follow the complete SPS task context from standard input. Do the requested work, then return a concise final report.",
        "--ttl",
        "900",
      ],
      cwd: "sps-project://project-1",
      env: expect.objectContaining({ PAPERCLIP_API_KEY: "hub-agent-token" }),
      stdin: expect.stringContaining("Local Worker"),
    }));
    expect(result.summary).toBe("LM Studio completed the task.");
    expect(result.provider).toBe("lm_studio");
  });
});
