import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../src/protocol.js";

describe("createHostClientHandlers invocation company scope", () => {
  it("gates Core memory lifecycle publication and preserves the invocation company", async () => {
    const publishLifecycle = vi.fn(async () => {});
    const services = { memory: { publishLifecycle } } as unknown as HostServices;
    const params = {
      companyId: "company-a",
      eventType: "room.checkpoint" as const,
      idempotencyKey: "room-a:checkpoint:1",
      roomId: "room-a",
    };

    const denied = createHostClientHandlers({
      pluginId: "sps.room-chat",
      capabilities: [],
      services,
    });
    await expect(denied["memory.publishLifecycle"](params)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(publishLifecycle).not.toHaveBeenCalled();

    const allowed = createHostClientHandlers({
      pluginId: "sps.room-chat",
      capabilities: ["memory.lifecycle.publish"],
      services,
    });
    await expect(allowed["memory.publishLifecycle"](params, {
      invocationScope: { companyId: "company-a" },
    })).resolves.toBeUndefined();
    expect(publishLifecycle).toHaveBeenCalledWith(params);

    await expect(allowed["memory.publishLifecycle"]({ ...params, companyId: "company-b" }, {
      invocationScope: { companyId: "company-a" },
    })).rejects.toBeInstanceOf(InvocationScopeDeniedError);
  });

  it("rejects company-scoped host calls outside the current invocation company", async () => {
    const projectsList = vi.fn(async () => []);
    const services = {
      projects: {
        list: projectsList,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["projects.read"],
      services,
    });

    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    await expect(
      handlers["projects.list"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
    });
    expect(projectsList).not.toHaveBeenCalled();
  });

  it("filters companies.list to the current invocation company", async () => {
    const services = {
      companies: {
        list: vi.fn(async () => [
          { id: "company-a", name: "Company A" },
          { id: "company-b", name: "Company B" },
        ]),
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["companies.read"],
      services,
    });

    await expect(
      handlers["companies.list"](
        {},
        { invocationScope: { companyId: "company-a" } },
      ),
    ).resolves.toEqual([{ id: "company-a", name: "Company A" }]);
  });

  it("rejects company-scope store access for a different company", async () => {
    const stateGet = vi.fn(async () => null);
    const services = {
      state: {
        get: stateGet,
      },
    } as unknown as HostServices;

    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["plugin.state.read"],
      services,
    });

    await expect(
      handlers["state.get"](
        { scopeKind: "company", scopeId: "company-b", stateKey: "settings" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(stateGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "access.members.list",
      "access.members.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.access.listMembers),
    ],
    [
      "access.members.update",
      "access.members.write",
      { companyId: "company-a", memberId: "member-a", patch: { status: "active" } },
      (services: HostServices) => vi.mocked(services.access.updateMember),
    ],
    [
      "authorization.grants.set",
      "authorization.grants.write",
      { companyId: "company-a", principalType: "agent", principalId: "agent-a", grants: [] },
      (services: HostServices) => vi.mocked(services.authorization.setGrants),
    ],
    [
      "authorization.policies.update",
      "authorization.policies.write",
      { companyId: "company-a", resourceType: "agent", resourceId: "agent-a", policy: null },
      (services: HostServices) => vi.mocked(services.authorization.updatePolicy),
    ],
    [
      "authorization.audit.search",
      "authorization.audit.read",
      { companyId: "company-a" },
      (services: HostServices) => vi.mocked(services.authorization.searchAudit),
    ],
  ] as const)(
    "rejects %s when the plugin lacks %s",
    async (method, capability, params, getDelegate) => {
      const services = {
        access: {
          listMembers: vi.fn(async () => []),
          updateMember: vi.fn(async () => ({ id: "member-a" })),
        },
        authorization: {
          setGrants: vi.fn(async () => []),
          updatePolicy: vi.fn(async () => ({ policy: null })),
          searchAudit: vi.fn(async () => []),
        },
      } as unknown as HostServices;
      const handlers = createHostClientHandlers({
        pluginId: "paperclip.test",
        capabilities: [],
        services,
      });

      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toMatchObject({
        name: "CapabilityDeniedError",
        message: expect.stringContaining(capability),
      });
      await expect(
        (handlers as Record<string, (input: unknown) => Promise<unknown>>)[method](params),
      ).rejects.toBeInstanceOf(CapabilityDeniedError);
      expect(getDelegate(services)).not.toHaveBeenCalled();
    },
  );

  it("checks invocation company scope before exposing authorization data", async () => {
    const searchAudit = vi.fn(async () => []);
    const services = {
      authorization: {
        searchAudit,
      },
    } as unknown as HostServices;
    const handlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["authorization.audit.read"],
      services,
    });

    await expect(
      handlers["authorization.audit.search"](
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      ),
    ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(searchAudit).not.toHaveBeenCalled();
  });

  it("requires issues.report before delegating atomic Task reports", async () => {
    const submitReport = vi.fn(async () => ({
      issue: { id: "issue-a" },
      comment: { id: "comment-a" },
      idempotent: false,
    }));
    const services = {
      issues: { submitReport },
    } as unknown as HostServices;
    const params = {
      issueId: "issue-a",
      companyId: "company-a",
      kind: "final" as const,
      body: "## Paperclip Final Report\nVerified output and changed paths are recorded.",
      actorAgentId: "agent-a",
      actorRunId: "run-a",
    };

    const deniedHandlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(deniedHandlers["issues.submitReport"](params)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(submitReport).not.toHaveBeenCalled();

    const allowedHandlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["issues.report"],
      services,
    });
    await allowedHandlers["issues.submitReport"](params);
    expect(submitReport).toHaveBeenCalledOnce();
  });

  it("gates runtime-discovered tools behind their dedicated capability", async () => {
    const replaceDynamic = vi.fn(async () => ({ registered: 1 }));
    const services = {
      agentTools: { replaceDynamic },
    } as unknown as HostServices;
    const params = {
      tools: [{
        name: "search-remote",
        displayName: "Search Remote",
        description: "Searches the connected service",
        parametersSchema: { type: "object", properties: {} },
      }],
    };

    const deniedHandlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: [],
      services,
    });
    await expect(deniedHandlers["agentTools.replaceDynamic"](params)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(replaceDynamic).not.toHaveBeenCalled();

    const allowedHandlers = createHostClientHandlers({
      pluginId: "paperclip.test",
      capabilities: ["agent.tools.dynamic.register"],
      services,
    });
    await expect(allowedHandlers["agentTools.replaceDynamic"](params)).resolves.toEqual({ registered: 1 });
    expect(replaceDynamic).toHaveBeenCalledWith(params);
  });

  it("gates workflow-neutral SPS runtime dispatch separately from Source discovery", async () => {
    const listWorkspaceSources = vi.fn(async () => [{
      id: "source-a",
      displayName: "Host source",
      status: "active",
      routeStatus: "configured" as const,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    }]);
    const dispatchRun = vi.fn(async () => ({ id: "run-a", status: "queued" }));
    const services = {
      sps: {
        listWorkspaceSources,
        dispatchRun,
      },
    } as unknown as HostServices;
    const sourceParams = { companyId: "company-a" };
    const dispatchParams = {
      companyId: "company-a",
      executionGrantId: "grant-a",
      args: ["exec", "Implement the approved change."],
    };

    const sourceOnly = createHostClientHandlers({
      pluginId: "sps.example-workplane",
      capabilities: ["sps.workspaceSources.read"],
      services,
    });
    await expect(sourceOnly["sps.workspaceSources.list"](sourceParams)).resolves.toHaveLength(1);
    await expect(sourceOnly["sps.runs.dispatch"](dispatchParams)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(dispatchRun).not.toHaveBeenCalled();

    const dispatchAllowed = createHostClientHandlers({
      pluginId: "sps.example-workplane",
      capabilities: ["sps.runs.dispatch"],
      services,
    });
    await expect(dispatchAllowed["sps.runs.dispatch"](dispatchParams)).resolves.toMatchObject({ id: "run-a" });
    expect(dispatchRun).toHaveBeenCalledWith(dispatchParams);
  });

  it("gates workflow-neutral artifact publication independently from run dispatch", async () => {
    const publishArtifact = vi.fn(async () => ({
      id: "artifact-a",
      companyId: "company-a",
      pluginKey: "sps.example-workplane",
      subjectKey: "worker-a",
      runId: null,
      title: "Build report",
      kind: "report",
      referenceUrl: null,
      summary: "Completed safely.",
      data: {},
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));
    const services = {
      sps: {
        publishArtifact,
      },
    } as unknown as HostServices;
    const params = {
      companyId: "company-a",
      subjectKey: "worker-a",
      title: "Build report",
      kind: "report",
    };
    const denied = createHostClientHandlers({
      pluginId: "sps.example-workplane",
      capabilities: ["sps.runs.dispatch"],
      services,
    });
    await expect(denied["sps.artifacts.publish"](params)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(publishArtifact).not.toHaveBeenCalled();

    const allowed = createHostClientHandlers({
      pluginId: "sps.example-workplane",
      capabilities: ["sps.artifacts.write"],
      services,
    });
    await expect(allowed["sps.artifacts.publish"](params)).resolves.toMatchObject({ id: "artifact-a" });
    expect(publishArtifact).toHaveBeenCalledWith(params);
  });

  it("keeps run listing read-only and cancellation behind an explicit capability", async () => {
    const listRuns = vi.fn(async () => []);
    const cancelRun = vi.fn(async () => ({ id: "run-a", status: "cancelling" }));
    const services = { sps: { listRuns, cancelRun } } as unknown as HostServices;
    const readOnly = createHostClientHandlers({ pluginId: "sps.example", capabilities: ["sps.runs.read"], services });
    const params = { companyId: "company-a", runId: "run-a" };
    await expect(readOnly["sps.runs.list"]({ companyId: "company-a", limit: 50 })).resolves.toEqual([]);
    await expect(readOnly["sps.runs.cancel"](params)).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(cancelRun).not.toHaveBeenCalled();
    const allowed = createHostClientHandlers({ pluginId: "sps.example", capabilities: ["sps.runs.cancel"], services });
    await expect(allowed["sps.runs.cancel"]({ companyId: "company-b", runId: "run-a" },
      { invocationScope: { companyId: "company-a" } })).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    expect(cancelRun).not.toHaveBeenCalled();
    await expect(allowed["sps.runs.cancel"](params)).resolves.toMatchObject({ status: "cancelling" });
    expect(cancelRun).toHaveBeenCalledWith(params);
  });
});
