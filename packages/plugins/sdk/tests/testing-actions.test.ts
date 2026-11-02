import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";
import type { Agent } from "@paperclipai/shared";

const manifest = {
  id: "paperclip.test-actions",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Actions",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

describe("createTestHarness action context", () => {
  it("passes immutable authenticated actor context and overrides caller company scope", async () => {
    const harness = createTestHarness({ manifest });

    harness.ctx.actions.register("inspect", async (params, context) => ({
      paramsCompanyId: params.companyId,
      actor: context.actor,
      companyId: context.companyId,
      contextFrozen: Object.isFrozen(context),
      actorFrozen: Object.isFrozen(context.actor),
    }));

    const result = await harness.performAction<{
      paramsCompanyId: unknown;
      actor: {
        type: string;
        userId: string | null;
        agentId: string | null;
        runId: string | null;
        companyId: string | null;
      };
      companyId: string | null;
      contextFrozen: boolean;
      actorFrozen: boolean;
    }>(
      "inspect",
      { companyId: "spoofed-company", value: true },
      {
        companyId: "host-company",
        actor: {
          type: "user",
          userId: "board-user-1",
          runId: "run-1",
        },
      },
    );

    expect(result.paramsCompanyId).toBe("host-company");
    expect(result.companyId).toBe("host-company");
    expect(result.actor).toEqual({
      type: "user",
      userId: "board-user-1",
      agentId: null,
      runId: "run-1",
      companyId: "host-company",
    });
    expect(result.contextFrozen).toBe(true);
    expect(result.actorFrozen).toBe(true);
  });

  it("keeps existing one-argument action handlers compatible", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.actions.register("legacy", async (params) => ({ ok: params.ok }));

    await expect(harness.performAction("legacy", { ok: true })).resolves.toEqual({ ok: true });
  });
});

describe("createTestHarness SPS execution history", () => {
  it("exposes the client methods but rejects calls without Host infrastructure", async () => {
    const harness = createTestHarness({ manifest });
    await expect(harness.ctx.sps.executions.list("company-1")).rejects.toThrow(
      "The in-memory plugin test harness does not provide SPS Node infrastructure",
    );
    await expect(harness.ctx.sps.executions.get(
      "company-1",
      "agent_session",
      "11111111-1111-4111-8111-111111111111",
    )).rejects.toThrow("The in-memory plugin test harness does not provide SPS Node infrastructure");
    await expect(harness.ctx.sps.executions.summarize("company-1", {
      from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z",
    })).rejects.toThrow("The in-memory plugin test harness does not provide SPS execution summaries");
  });
});

describe("createTestHarness Agent session ensure", () => {
  it("models remembered task-key ownership and configuration, without claiming database durability", async () => {
    const agent = { id: "agent-a", companyId: "company-1", adapterType: "test" } as Agent;
    const otherAgent = { id: "agent-b", companyId: "company-1", adapterType: "test" } as Agent;
    const denied = createTestHarness({ manifest });
    denied.seed({ agents: [agent, otherAgent] });
    await expect(denied.ctx.agents.sessions.ensure("agent-a", "company-1", { taskKey: "plugin:task-1" }))
      .rejects.toThrow("agent.sessions.create");

    const harness = createTestHarness({
      manifest,
      capabilities: ["agent.sessions.create", "agent.sessions.close"],
    });
    harness.seed({ agents: [agent, otherAgent] });
    const context = { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const taskKey = `plugin:${manifest.id}:session:task-1`;
    const first = await harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, context,
    });
    const retry = await harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, expectedSessionId: first.sessionId, context,
    });
    const uppercaseRetry = await harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, expectedSessionId: first.sessionId.toUpperCase(), context,
    });
    const otherAgentSession = await harness.ctx.agents.sessions.ensure("agent-b", "company-1", {
      taskKey, context,
    });

    expect(first).toMatchObject({ created: true });
    expect(retry).toEqual({ sessionId: first.sessionId, created: false });
    expect(uppercaseRetry).toEqual({ sessionId: first.sessionId, created: false });
    expect(otherAgentSession).toMatchObject({ created: true });
    expect(otherAgentSession.sessionId).not.toBe(first.sessionId);
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, expectedSessionId: "99999999-9999-4999-8999-999999999999", context,
    })).rejects.toThrow("does not match the remembered task key");
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, context: { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    })).rejects.toThrow("explicit review is required");

    const adapterKey = `plugin:${manifest.id}:session:task-adapter`;
    await harness.ctx.agents.sessions.ensure("agent-a", "company-1", { taskKey: adapterKey });
    harness.seed({ agents: [{ ...agent, adapterType: "changed" }] });
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", { taskKey: adapterKey }))
      .rejects.toThrow("explicit review is required");

    await harness.ctx.agents.sessions.close(first.sessionId, "company-1");
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey, expectedSessionId: first.sessionId, context,
    })).rejects.toThrow("explicit review is required");
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey: `plugin:${manifest.id}:session:missing`, expectedSessionId: "88888888-8888-4888-8888-888888888888",
    })).rejects.toThrow("no longer available");
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey: `plugin:${manifest.id}:session:missing`,
    })).resolves.toMatchObject({ created: true });
    for (const contextValue of [
      null,
      [],
      "invalid",
      { unsupported: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { projectId: "not-a-uuid" },
      { issueId: null },
    ]) {
      await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
        taskKey, context: contextValue as never,
      })).rejects.toThrow("Session context must contain only supported UUID references");
    }
    // Valid UUID syntax is checked here; this in-memory fake cannot validate database references.
    await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
      taskKey: `plugin:${manifest.id}:session:unseeded-reference`,
      context: { projectWorkspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    })).resolves.toMatchObject({ created: true });
    await expect(harness.ctx.agents.sessions.create("agent-a", "company-1", {
      context: { unsupported: "legacy-permissive" } as never,
    })).resolves.toMatchObject({ status: "active" });
    for (const expectedSessionId of ["", "not-a-uuid", null as unknown as string]) {
      await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", {
        taskKey, expectedSessionId, context,
      })).rejects.toThrow("Expected session ID must be a UUID");
    }
    for (const invalid of ["plugin:foreign:session:key", `plugin:${manifest.id}:session:`, `${taskKey}\0`, `${taskKey}\ud800`, `${taskKey}${"x".repeat(1024)}`]) {
      await expect(harness.ctx.agents.sessions.ensure("agent-a", "company-1", { taskKey: invalid }))
        .rejects.toThrow("owned by this plugin");
    }
  });
});

describe("createTestHarness issue interactions", () => {
  it("creates request_checkbox_confirmation interactions through the typed host helper", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: ["issues.create", "issue.interactions.create"],
    });
    const issue = await harness.ctx.issues.create({
      companyId: "company-1",
      title: "Pick files",
    });

    const interaction = await harness.ctx.issues.requestCheckboxConfirmation(
      issue.id,
      {
        idempotencyKey: "checkbox:files",
        title: "Choose files",
        payload: {
          version: 1,
          prompt: "Which files should be included?",
          options: [
            { id: "file-a", label: "File A" },
            { id: "file-b", label: "File B", description: "Secondary draft" },
          ],
          defaultSelectedOptionIds: ["file-a"],
          minSelected: 1,
          maxSelected: 2,
        },
      },
      "company-1",
      { authorAgentId: "agent-1" },
    );

    expect(interaction).toMatchObject({
      issueId: issue.id,
      companyId: "company-1",
      kind: "request_checkbox_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "checkbox:files",
      title: "Choose files",
      createdByAgentId: "agent-1",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        options: [
          { id: "file-a", label: "File A" },
          { id: "file-b", label: "File B", description: "Secondary draft" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
      },
    });
  });
});

describe("createTestHarness issue reports", () => {
  it("enforces capability and mirrors final-report idempotency", async () => {
    const deniedHarness = createTestHarness({
      manifest,
      capabilities: ["issues.create"],
    });
    const deniedIssue = await deniedHarness.ctx.issues.create({
      companyId: "company-1",
      title: "Denied report",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    await expect(deniedHarness.ctx.issues.submitReport({
      issueId: deniedIssue.id,
      companyId: "company-1",
      kind: "final",
      body: "## Paperclip Final Report\nVerified output and changed paths are recorded.",
      actorAgentId: "agent-1",
      actorRunId: "run-1",
    })).rejects.toThrow("issues.report");

    const harness = createTestHarness({
      manifest,
      capabilities: ["issues.create", "issues.report"],
    });
    const issue = await harness.ctx.issues.create({
      companyId: "company-1",
      title: "Atomic report",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    const input = {
      issueId: issue.id,
      companyId: "company-1",
      kind: "final" as const,
      body: "## Paperclip Final Report\nVerified output and changed paths are recorded.",
      actorAgentId: "agent-1",
      actorRunId: "run-1",
    };

    const first = await harness.ctx.issues.submitReport(input);
    const retry = await harness.ctx.issues.submitReport(input);
    expect(first.issue.status).toBe("in_review");
    expect(first.idempotent).toBe(false);
    expect(retry.idempotent).toBe(true);
    expect(retry.comment.id).toBe(first.comment.id);
  });
});
