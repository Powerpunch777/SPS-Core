import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Company, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  formatWorkerFailureMessage,
  type WorkerInvocationAuthority,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope.cjs",
);
const TERMINATED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-terminated.cjs");

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

function createTestCompany(id: string): Company {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id,
    name: "Test company",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "TST",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });

  it("times out environmentExecute calls using the handle default when no override is provided", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        delayMs: 50,
      } as HostToWorkerMethods["environmentExecute"][0])).rejects.toMatchObject({
        message: expect.stringContaining("timed out after 10ms"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("honors per-call timeout overrides for environmentExecute", async () => {
    let signalReady!: () => void;
    let releaseResponse!: () => void;
    const workerReady = new Promise<void>((resolve) => { signalReady = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: { "config.get": async () => { signalReady(); await responseGate; return {}; } },
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();
      const readinessTimeout = new Promise<never>((_resolve, reject) => {
        readinessTimer = setTimeout(() => reject(new Error("worker did not reach the held response")), 5_000);
      });
      vi.useFakeTimers();
      const call = handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        testHandshake: true,
      } as HostToWorkerMethods["environmentExecute"][0], 100);
      const observedCall = call.then((value) => ({ value }), (error: unknown) => ({ error }));
      const readiness = await Promise.race([
        workerReady.then(() => "ready" as const),
        observedCall.then((settlement) => ({ settlement })),
        readinessTimeout.then(() => "timed-out" as const),
      ]);
      if (readinessTimer) clearTimeout(readinessTimer);
      readinessTimer = undefined;
      expect(readiness).toBe("ready");
      await vi.advanceTimersByTimeAsync(11);
      let callSettled = false;
      void observedCall.then(() => { callSettled = true; });
      await Promise.resolve();
      expect(callSettled).toBe(false);
      releaseResponse();
      await Promise.resolve();
      await expect(call).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" });
    } finally {
      vi.useRealTimers();
      if (readinessTimer) clearTimeout(readinessTimer);
      releaseResponse();
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not treat a local timeout as a handler terminal acknowledgement", async () => {
    let signalReady!: () => void;
    let releaseResponse!: () => void;
    let signalTerminal!: (reason: "response" | "worker_exit" | "not_dispatched") => void;
    const workerReady = new Promise<void>((resolve) => { signalReady = resolve; });
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const terminal = new Promise<"response" | "worker_exit" | "not_dispatched">((resolve) => { signalTerminal = resolve; });
    const onTerminal = vi.fn(signalTerminal);
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const readinessTimeout = new Promise<never>((_resolve, reject) => {
      readinessTimer = setTimeout(() => reject(new Error("worker did not reach the held response")), 5_000);
    });
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const terminalTimeout = new Promise<never>((_resolve, reject) => {
      terminalTimer = setTimeout(() => reject(new Error("worker response did not settle")), 5_000);
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "config.get": async () => { signalReady(); await responseGate; return {}; } },
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();
      vi.useFakeTimers();
      const call = handle.call("environmentExecute", {
        driverKey: "e2b",
        companyId: "company-1",
        environmentId: "environment-1",
        config: {},
        lease: { providerLeaseId: "lease-1" },
        command: "echo",
        testHandshake: true,
      } as HostToWorkerMethods["environmentExecute"][0], 10, {
        assertCurrent: () => undefined,
        onTerminal,
      });
      const observedCall = call.then(
        () => ({ unexpectedResponse: true as const }),
        (error: unknown) => ({ error }),
      );
      const readiness = await Promise.race([
        workerReady.then(() => "ready" as const),
        observedCall.then((settlement) => ({ settlement })),
        readinessTimeout.then(() => "timed-out" as const),
      ]);
      expect(readiness).toBe("ready");
      if (readinessTimer) clearTimeout(readinessTimer);
      readinessTimer = undefined;
      await vi.advanceTimersByTimeAsync(10);
      const settlement = await observedCall;
      expect(settlement).toMatchObject({ error: { code: PLUGIN_RPC_ERROR_CODES.TIMEOUT } });

      expect(onTerminal).not.toHaveBeenCalled();
      vi.useRealTimers();
      releaseResponse();
      await expect(Promise.race([terminal, terminalTimeout])).resolves.toBe("response");
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith("response");
    } finally {
      if (readinessTimer) clearTimeout(readinessTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      vi.useRealTimers();
      releaseResponse();
      await handle.stop().catch(() => undefined);
    }
  });

  it("keeps a shared worker invocation for another Workspace alive after one invocation is cancelled", async () => {
    const controller = new AbortController();
    const aTerminal = vi.fn();
    const bTerminal = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      rpcTimeoutMs: 500,
    });

    try {
      await handle.start();
      const runA = handle.call("environmentExecute", {
        driverKey: "e2b", companyId: "workspace-a", environmentId: "environment-a",
        config: {}, lease: { providerLeaseId: "lease-a" }, command: "echo", delayMs: 60,
      } as HostToWorkerMethods["environmentExecute"][0], 500, {
        signal: controller.signal,
        assertCurrent: () => undefined,
      }, aTerminal);
      const runB = handle.call("environmentExecute", {
        driverKey: "e2b", companyId: "workspace-b", environmentId: "environment-b",
        config: {}, lease: { providerLeaseId: "lease-b" }, command: "echo", delayMs: 20,
      } as HostToWorkerMethods["environmentExecute"][0], 500, undefined, bTerminal);

      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(runA).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      await expect(runB).resolves.toMatchObject({ exitCode: 0, stdout: "ok\n" });
      expect(aTerminal).toHaveBeenCalledTimes(1);
      expect(aTerminal).toHaveBeenCalledWith("response");
      expect(bTerminal).toHaveBeenCalledTimes(1);
      expect(bTerminal).toHaveBeenCalledWith("response");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("accepts execution authority for an exact Host runJob invocation", async () => {
    const onTerminal = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      await handle.start();
      await expect(handle.call("runJob", {
        job: { jobKey: "host-job", runId: "run-host-1", trigger: "manual", scheduledAt: new Date().toISOString() },
      }, 500, { allowHostInvocation: true, assertCurrent: () => undefined }, onTerminal))
        .rejects.toMatchObject({ message: expect.stringContaining("Unhandled method: runJob") });
      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith("response");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not emit an unhandled rejection when a plugin responds with terminated before callers attach handlers", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: TERMINATED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {},
    });

    try {
      await handle.start();

      const pendingCall = handle.call(
        "environmentExecute" as keyof HostToWorkerMethods,
        {
          driverKey: "e2b",
          companyId: "company-1",
          environmentId: "environment-1",
          config: {},
          lease: { providerLeaseId: "lease-1" },
          command: "echo",
        } as HostToWorkerMethods[keyof HostToWorkerMethods][0],
      );

      await new Promise((resolve) => setImmediate(resolve));

      await expect(pendingCall).rejects.toBeInstanceOf(JsonRpcCallError);
      await expect(pendingCall).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes performAction invocation scope to nested worker host calls", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet as never,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "echo",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).resolves.toEqual({
        id: "company-a",
        scopedCompanyId: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes echoed invocation scope to worker-to-host handlers", async () => {
    const companiesGet = vi.fn(async () => createTestCompany("company-1"));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: {
        "companies.get": companiesGet,
      },
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: {
          mode: "echo",
          requestedCompanyId: "company-1",
        },
      } as HostToWorkerMethods["getData"][0])).resolves.toMatchObject({ id: "company-1" });

      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("gives scheduled Jobs an instance invocation scope for nested host calls", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const scopedCompaniesGet = vi.fn();
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const baseCompaniesGet = hostHandlers["companies.get"]!;
    (hostHandlers as Record<string, unknown>)["companies.get"] = async (params: unknown, context?: unknown) => {
      scopedCompaniesGet(params, context);
      return baseCompaniesGet(params as never, context as never);
    };
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      await expect(handle.call("runJob", {
        job: {
          jobKey: "scope-probe",
          runId: "job-run-1",
          trigger: "schedule",
          scheduledAt: new Date().toISOString(),
          requestedCompanyId: "company-b",
          mode: "echo",
        },
      } as HostToWorkerMethods["runJob"][0])).resolves.toMatchObject({ id: "company-b" });

      expect(companiesGet).toHaveBeenCalledWith({ companyId: "company-b" });
      expect(scopedCompaniesGet).toHaveBeenCalledWith(
        { companyId: "company-b" },
        { invocationScope: {} },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("scopes workspace Jobs to their company for nested host calls", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const scopedCompaniesGet = vi.fn();
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const baseCompaniesGet = hostHandlers["companies.get"]!;
    (hostHandlers as Record<string, unknown>)["companies.get"] = async (params: unknown, context?: unknown) => {
      scopedCompaniesGet(params, context);
      return baseCompaniesGet(params as never, context as never);
    };
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      await expect(handle.call("runJob", {
        job: {
          jobKey: "scope-probe",
          runId: "job-run-1",
          trigger: "schedule",
          scheduledAt: new Date().toISOString(),
          companyId: "company-a",
          requestedCompanyId: "company-a",
          mode: "echo",
        },
      } as HostToWorkerMethods["runJob"][0])).resolves.toEqual({ id: "company-a" });

      await expect(handle.call("runJob", {
        job: {
          jobKey: "scope-probe",
          runId: "job-run-2",
          trigger: "schedule",
          scheduledAt: new Date().toISOString(),
          companyId: "company-a",
          requestedCompanyId: "company-b",
          mode: "echo",
        },
      } as HostToWorkerMethods["runJob"][0])).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining('requested company "company-b"'),
      });

      expect(companiesGet).toHaveBeenCalledTimes(1);

      expect(scopedCompaniesGet).toHaveBeenNthCalledWith(
        1,
        { companyId: "company-a" },
        { invocationScope: { companyId: "company-a" } },
      );
      expect(scopedCompaniesGet).toHaveBeenNthCalledWith(
        2,
        { companyId: "company-b" },
        { invocationScope: { companyId: "company-a" } },
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects performAction nested host calls that omit the invocation id", async () => {
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          list: vi.fn(async () => []),
          get: vi.fn(async (params: { companyId: string }) => ({ id: params.companyId })),
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          requestedCompanyId: "company-b",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects nested worker host calls that forge an unknown invocation id", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "unknown",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects missing or unknown invocation ids while a company invocation is active", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-2" }));
    const hostHandlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const mode of ["omit", "unknown"]) {
        await expect(handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: {
            mode,
            requestedCompanyId: "company-2",
          },
        } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }

      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("checks host-only invocation authority before dispatch and for nested worker calls", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const streamNotification = vi.fn();
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
      onStreamNotification: streamNotification,
    });
    const authority = { assertCurrent: vi.fn() };

    try {
      await handle.start();
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "echo", requestedCompanyId: "company-1" },
      } as HostToWorkerMethods["getData"][0], undefined, authority)).resolves.toMatchObject({ id: "company-1" });
      expect(authority.assertCurrent).toHaveBeenCalledTimes(4);
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        { invocationScope: { companyId: "company-1" } },
      );
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "stream" },
      } as HostToWorkerMethods["getData"][0], undefined, authority)).resolves.toEqual({ ok: true });
      expect(streamNotification).toHaveBeenCalledWith(
        "streams.emit",
        expect.objectContaining({ companyId: "company-1" }),
        expect.any(String),
        expect.any(Function),
      );
      const opaqueInvocation = await handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "returnInvocation" },
      } as HostToWorkerMethods["getData"][0], undefined, authority);
      expect(opaqueInvocation).toEqual({
        invocationId: expect.stringMatching(/^sps-guarded:[0-9a-f-]{36}$/),
      });
      expect(authority.assertCurrent).toHaveBeenCalledTimes(14);

      const denied = { assertCurrent: vi.fn(() => { throw new Error("private authority details"); }) };
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "echo", requestedCompanyId: "company-1" },
      } as HostToWorkerMethods["getData"][0], undefined, denied)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: "Plugin invocation authority is no longer current",
      });
      expect(denied.assertCurrent).toHaveBeenCalledTimes(1);
      expect(companiesGet).toHaveBeenCalledTimes(1);

      const missingScopeAuthority = { assertCurrent: vi.fn() };
      await expect(handle.call("getData", {
        key: "probe",
        params: { mode: "echo", requestedCompanyId: "company-1" },
      } as HostToWorkerMethods["getData"][0], undefined, missingScopeAuthority)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
      expect(missingScopeAuthority.assertCurrent).not.toHaveBeenCalled();
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("exposes a synchronous publish fence after an asynchronous stream callback", async () => {
    let entered!: () => void;
    let release!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const callbackGate = new Promise<void>((resolve) => { release = resolve; });
    const forwarded: string[] = [];
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      onStreamNotification: async (method, _params, _generation, canPublish) => {
        if (method === "streams.emit") {
          entered();
          await callbackGate;
        }
        if (canPublish()) forwarded.push(method);
      },
    });

    try {
      await handle.start();
      let settled = false;
      const call = handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "stream-lifecycle" },
      } as HostToWorkerMethods["getData"][0], undefined, {
        assertCurrent: () => undefined,
      }).finally(() => { settled = true; });
      await callbackEntered;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      release();
      await call;
      expect(forwarded).toEqual(["streams.open", "streams.emit", "streams.close"]);
    } finally {
      release();
      await handle.stop().catch(() => undefined);
    }
  });

  it("bounds queued stream notifications and drops a generation after overflow", async () => {
    let unblockStream!: () => void;
    let streamCallbackStarted!: () => void;
    let responseReceived!: () => void;
    const streamGate = new Promise<void>((resolve) => { unblockStream = resolve; });
    const streamStarted = new Promise<void>((resolve) => { streamCallbackStarted = resolve; });
    const responseArrived = new Promise<void>((resolve) => { responseReceived = resolve; });
    const notifications: Array<{ method: string; canPublish: boolean }> = [];
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      onStreamNotification: async (method, _params, _generation, canPublish) => {
        if (method === "streams.open") {
          streamCallbackStarted();
          await streamGate;
        }
        notifications.push({ method, canPublish: canPublish() });
      },
    });

    try {
      await handle.start();
      const call = handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "stream-flood" },
      } as HostToWorkerMethods["getData"][0], 10_000, {
        assertCurrent: () => undefined,
        onTerminal: (reason) => { if (reason === "response") responseReceived(); },
      });
      let settled = false;
      void call.then(() => { settled = true; }, () => { settled = true; });
      await streamStarted;
      await responseArrived;
      expect(settled).toBe(false);
      unblockStream();
      await call;
      expect(notifications.map(({ method }) => method)).toEqual(["streams.open", "streams.close"]);
      expect(notifications[0]?.canPublish).toBe(false);
    } finally {
      unblockStream();
      await handle.stop().catch(() => undefined);
    }
  }, 10_000);

  it("binds a guarded worker dispatch to the captured Workspace authority", async () => {
    const workspaceA = "00000000-0000-4000-8000-000000000001";
    const workspaceB = "00000000-0000-4000-8000-000000000002";
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
    });

    try {
      await handle.start();
      const acceptedTerminal = vi.fn();
      await expect(handle.call("getData", {
        key: "probe",
        companyId: workspaceA,
        params: { mode: "echo", requestedCompanyId: workspaceA },
      } as HostToWorkerMethods["getData"][0], undefined, {
        boundWorkspaceId: workspaceA,
        assertCurrent: () => undefined,
      }, acceptedTerminal)).resolves.toMatchObject({ id: workspaceA });
      expect(acceptedTerminal).toHaveBeenCalledExactlyOnceWith("response");
      expect(companiesGet).toHaveBeenCalledExactlyOnceWith(
        { companyId: workspaceA },
        { invocationScope: { companyId: workspaceA } },
      );

      const deniedCalls = [
        {
          params: { key: "probe", companyId: workspaceA, params: { mode: "echo", requestedCompanyId: workspaceA } },
          authority: { boundWorkspaceId: workspaceB, assertCurrent: vi.fn() },
        },
        {
          params: { key: "probe", params: { mode: "echo", requestedCompanyId: workspaceA } },
          authority: { boundWorkspaceId: workspaceA, assertCurrent: vi.fn() },
        },
        {
          params: { key: "probe", companyId: workspaceA, params: { mode: "echo", requestedCompanyId: workspaceA } },
          authority: { boundWorkspaceId: "not-a-workspace-id", assertCurrent: vi.fn() },
        },
      ];
      for (const denied of deniedCalls) {
        const terminal = vi.fn();
        await expect(handle.call("getData", denied.params as HostToWorkerMethods["getData"][0], undefined,
          denied.authority as WorkerInvocationAuthority, terminal)).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
        expect(terminal).toHaveBeenCalledExactlyOnceWith("not_dispatched");
        expect(denied.authority.assertCurrent).not.toHaveBeenCalled();
      }

      const actorScopeTerminal = vi.fn();
      await expect(handle.call("performAction", {
        key: "probe",
        companyId: workspaceA,
        params: { mode: "echo", requestedCompanyId: workspaceA },
        actorContext: { companyId: workspaceB },
      } as HostToWorkerMethods["performAction"][0], undefined, {
        boundWorkspaceId: workspaceA,
        assertCurrent: vi.fn(),
      }, actorScopeTerminal)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(actorScopeTerminal).toHaveBeenCalledExactlyOnceWith("not_dispatched");

      const hostRunTerminal = vi.fn();
      await expect(handle.call("runJob", {
        job: { jobKey: "legacy-host-job", payload: { mode: "echo", requestedCompanyId: workspaceA } },
      } as HostToWorkerMethods["runJob"][0], undefined, {
        boundWorkspaceId: workspaceA,
        allowHostInvocation: true,
        assertCurrent: vi.fn(),
      }, hostRunTerminal)).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(hostRunTerminal).toHaveBeenCalledExactlyOnceWith("not_dispatched");
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("captures bound Workspace authority before async checks and rejects mutated call scope", async () => {
    const workspaceA = "00000000-0000-4000-8000-000000000001";
    const workspaceB = "00000000-0000-4000-8000-000000000002";
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
    });
    let releaseCheck!: () => void;
    const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });

    try {
      await handle.start();
      const mutableAuthority = {
        boundWorkspaceId: workspaceA,
        assertCurrent: vi.fn(async () => { await checkGate; }),
      };
      const acceptedParams = {
        key: "probe",
        companyId: workspaceA,
        params: { mode: "echo", requestedCompanyId: workspaceA },
      };
      const accepted = handle.call("getData", acceptedParams as HostToWorkerMethods["getData"][0], undefined,
        mutableAuthority as WorkerInvocationAuthority);
      await new Promise((resolve) => setImmediate(resolve));
      mutableAuthority.boundWorkspaceId = workspaceB;
      releaseCheck();
      await expect(accepted).resolves.toMatchObject({ id: workspaceA });
      expect(companiesGet).toHaveBeenCalledTimes(1);

      let releaseMutatedCheck!: () => void;
      const mutatedCheckGate = new Promise<void>((resolve) => { releaseMutatedCheck = resolve; });
      const rejectedParams = {
        key: "probe",
        companyId: workspaceA,
        params: { mode: "echo", requestedCompanyId: workspaceA },
      };
      const terminal = vi.fn();
      const rejected = handle.call("getData", rejectedParams as HostToWorkerMethods["getData"][0], undefined, {
        boundWorkspaceId: workspaceA,
        assertCurrent: async () => { await mutatedCheckGate; },
      }, terminal);
      await new Promise((resolve) => setImmediate(resolve));
      rejectedParams.companyId = workspaceB;
      releaseMutatedCheck();
      await expect(rejected).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(terminal).toHaveBeenCalledExactlyOnceWith("not_dispatched");
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      releaseCheck();
      await handle.stop().catch(() => undefined);
    }
  });

  it("suppresses an aborted guarded result while retaining call accounting until settlement", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
    });
    const controller = new AbortController();

    try {
      await handle.start();
      const call = handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "waitThenCall", requestedCompanyId: "company-1", delayMs: 250 },
      } as HostToWorkerMethods["getData"][0], undefined, {
        assertCurrent: () => undefined,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      let settled = false;
      void call.then(() => { settled = true; }, () => { settled = true; });
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(handle.diagnostics().pendingRequests).toBe(1);
      await expect(call).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(settled).toBe(true);
      expect(companiesGet).not.toHaveBeenCalled();
      expect(handle.diagnostics().pendingRequests).toBe(0);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rechecks changed authority and denies missing, mismatched, and stale guarded IDs", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
    });

    try {
      await handle.start();
      let checks = 0;
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "echo", requestedCompanyId: "company-1" },
      } as HostToWorkerMethods["getData"][0], undefined, {
        assertCurrent: () => { checks++; if (checks === 2) throw new Error("authority changed"); },
      })).rejects.toMatchObject({ code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED });
      expect(companiesGet).not.toHaveBeenCalled();

      for (const mode of ["omit", "unknown"]) {
        await expect(handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: { mode, requestedCompanyId: "company-1" },
        } as HostToWorkerMethods["getData"][0], undefined, { assertCurrent: () => undefined })).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }
      expect(companiesGet).not.toHaveBeenCalled();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "late", requestedCompanyId: "company-1" },
      } as HostToWorkerMethods["getData"][0], undefined, { assertCurrent: () => undefined })).resolves.toMatchObject({ id: "company-1" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(companiesGet).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("keeps explicit legacy worker invocations functional while a guarded call is active", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => createTestCompany(params.companyId));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: { "companies.get": companiesGet },
    });

    try {
      await handle.start();
      const guarded = handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "waitEcho", requestedCompanyId: "company-1", delayMs: 80 },
      } as HostToWorkerMethods["getData"][0], undefined, { assertCurrent: () => undefined });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-2",
        params: { mode: "echo", requestedCompanyId: "company-2" },
      } as HostToWorkerMethods["getData"][0])).resolves.toMatchObject({ id: "company-2" });
      await expect(guarded).resolves.toMatchObject({ id: "company-1" });
      expect(companiesGet).toHaveBeenCalledTimes(2);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
