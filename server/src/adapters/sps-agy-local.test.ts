import { describe, expect, it, vi } from "vitest";
import type { AdapterSpsNodeRunner } from "@paperclipai/adapter-utils/execution-target";
import { executeSpsAgyLocal } from "./sps-agy-local.js";

describe("SPS Agy CLI adapter", () => {
  it("runs on an SPS Node without forwarding Hub workspaces or provider credentials", async () => {
    const runner = vi.fn(async (_input: Parameters<AdapterSpsNodeRunner["execute"]>[0]) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Agy completed the task.",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }));

    const result = await executeSpsAgyLocal({
      runId: "agy-node-run",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Worker",
        adapterType: "sps_agy_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "agy", model: "gemini-3.5-flash", sandbox: true },
      context: {
        paperclipWorkspace: { cwd: process.cwd(), source: "project_primary" },
        paperclipWorkspaces: [{ cwd: "C:\\hub-only-workspace" }],
      },
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
      command: "agy",
      cwd: "sps-project://project-1",
      args: expect.arrayContaining(["--print", "--dangerously-skip-permissions", "--sandbox"]),
      env: expect.objectContaining({
        ANTIGRAVITY_MODEL: "gemini-3.5-flash",
        PAPERCLIP_API_KEY: "hub-agent-token",
      }),
    }));
    const args = runner.mock.calls[0]?.[0]?.args ?? [];
    const executionEnv = runner.mock.calls[0]?.[0]?.env ?? {};
    expect(args).not.toContain("--add-dir");
    expect(JSON.stringify(executionEnv)).not.toContain("hub-only-workspace");
    expect(result.summary).toBe("Agy completed the task.");
  });
});
