import { describe, expect, it, vi } from "vitest";
import { createPluginPlatformClient } from "../src/platform-client.js";

describe("plugin platform facade", () => {
  it("maps a durable session to a neutral Thread and preserves thread-scoped state", async () => {
    const sessions = {
      create: vi.fn().mockResolvedValue({
        sessionId: "thread-1",
        agentId: "agent-1",
        companyId: "company-1",
        status: "active",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        context: { projectId: "project-1", issueId: "work-1" },
        lastRunId: null,
        lastError: null,
      }),
      list: vi.fn(),
      sendMessage: vi.fn(),
      close: vi.fn(),
    };
    const state = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const platform = createPluginPlatformClient({
      agents: { get: vi.fn(), sessions },
      state,
    } as never);

    const thread = await platform.threads.create({
      scope: { organizationId: "company-1", projectId: "project-1", workItemId: "work-1" },
      agentId: "agent-1",
      threadKey: "designer-room",
    });
    await platform.stores.setState({
      scope: { organizationId: "company-1", threadId: thread.id },
      stateKey: "checkpoint",
    }, { version: 1 });

    expect(thread.scope).toMatchObject({
      organizationId: "company-1",
      projectId: "project-1",
      workItemId: "work-1",
      threadId: "thread-1",
    });
    expect(sessions.create).toHaveBeenCalledWith("agent-1", "company-1", expect.objectContaining({
      taskKey: "platform:designer-room",
    }));
    expect(state.set).toHaveBeenCalledWith(expect.objectContaining({
      scopeKind: "thread",
      scopeId: "thread-1",
      stateKey: "checkpoint",
    }), { version: 1 });
  });
});
