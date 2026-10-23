import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

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
