import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createRequest,
  createErrorResponse,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  PLUGIN_RPC_ERROR_CODES,
  serializeMessage,
  type JsonRpcResponse,
  type PluginInvocationContext,
} from "../src/protocol.js";
import { isWorkerEntrypoint, startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("isWorkerEntrypoint", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createTempRoot(): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sdk-worker-"));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it("matches an entrypoint reached through a symlinked directory", () => {
    const tempRoot = createTempRoot();
    const realDir = path.join(tempRoot, "real");
    const linkDir = path.join(tempRoot, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "dir");

    const workerPath = path.join(realDir, "worker.js");
    fs.writeFileSync(workerPath, "");

    expect(
      isWorkerEntrypoint(
        path.join(linkDir, "worker.js"),
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(true);
  });

  it("does not match a different entrypoint", () => {
    const tempRoot = createTempRoot();
    const workerPath = path.join(tempRoot, "worker.js");
    const otherPath = path.join(tempRoot, "other.js");
    fs.writeFileSync(workerPath, "");
    fs.writeFileSync(otherPath, "");

    expect(
      isWorkerEntrypoint(
        otherPath,
        pathToFileURL(workerPath).toString(),
      ),
    ).toBe(false);
  });
});

describe("worker performAction context", () => {
  it("starts before initialize without eagerly reading the manifest", () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const plugin = definePlugin({});

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    worker.stop();
    hostToWorker.destroy();
    workerToHost.destroy();
  });

  it("does not derive context companyId from caller params without host actor context", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("inspect", async (params, context) => ({
          paramsCompanyId: params.companyId,
          actor: context.actor,
          companyId: context.companyId,
        }));
      },
    });
    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown) {
      const id = `host-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (!isJsonRpcResponse(message)) return;
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "paperclip.test-worker-context",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Worker Context Test",
          description: "Test plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: [],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });

      await expect(callWorker("performAction", {
        key: "inspect",
        params: { companyId: "spoofed-company" },
      })).resolves.toEqual({
        paramsCompanyId: "spoofed-company",
        actor: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: null,
        },
        companyId: null,
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker event delivery", () => {
  it("reports handler failures after all matching handlers have run", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    let nextRequestId = 1;
    let handled = 0;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.events.on("task.completed", async () => {
          handled += 1;
          throw new Error("provider write failed");
        });
        ctx.events.on("task.completed", async () => {
          handled += 1;
        });
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    function callWorker(method: string, params: unknown) {
      const id = `host-event-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (isJsonRpcRequest(message) && message.method === "events.subscribe") {
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, null)));
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "sps.test-memory-events",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Memory Event Test",
          description: "Test plugin",
          author: "SPS",
          categories: ["automation"],
          capabilities: ["events.subscribe"],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      });

      await expect(callWorker("onEvent", {
        event: {
          eventId: "event-1",
          eventType: "task.completed",
          companyId: "company-1",
          occurredAt: "2026-07-22T00:00:00.000Z",
          actorType: "system",
          payload: {},
        },
      })).rejects.toThrow(/event handler/);
      expect(handled).toBe(2);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker invocation scope propagation", () => {
  it("keeps overlapping company scopes local to each getData invocation", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const nestedInvocationIds: string[] = [];
    const invocationCompanies = new Map([
      ["invocation-a", "company-a"],
      ["invocation-b", "company-b"],
    ]);
    let releaseCompanyA: (() => void) | null = null;
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.data.register("probe", async (params) => {
          if (params.label === "a") {
            await new Promise<void>((resolve) => {
              releaseCompanyA = resolve;
            });
          }
          const company = await ctx.companies.get(String(params.requestedCompanyId));
          return { label: params.label, company };
        });
      },
    });

    const worker = startWorkerRpcHost({
      plugin,
      stdin: hostToWorker,
      stdout: workerToHost,
    });

    function callWorker(method: string, params: unknown, invocation?: PluginInvocationContext) {
      const id = `host-${nextRequestId++}`;
      const request = {
        ...createRequest(method, params, id),
        ...(invocation ? { paperclipInvocation: invocation } : {}),
      };
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(request));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }

      if (!isJsonRpcRequest(message)) return;
      if (message.method !== "companies.get") return;

      const invocationId = (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "";
      const requestedCompanyId = (message.params as { companyId?: string }).companyId;
      const allowedCompanyId = invocationCompanies.get(invocationId);
      nestedInvocationIds.push(invocationId);
      if (requestedCompanyId !== allowedCompanyId) {
        hostToWorker.write(serializeMessage(createErrorResponse(
          message.id,
          PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
          `requested company "${requestedCompanyId}" but invocation "${invocationId}" is scoped to "${allowedCompanyId}"`,
        )));
        return;
      }

      hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {
        id: requestedCompanyId,
      })));

      if (invocationId === "invocation-b") {
        releaseCompanyA?.();
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "paperclip.scope-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Scope test",
          description: "Scope test",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["companies.read"],
          entrypoints: { worker: "dist/worker.js" },
        },
        config: {},
        instanceInfo: { instanceId: "test", hostVersion: "0.0.0" },
        apiVersion: 1,
      });

      const companyARequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-a",
          params: { label: "a", requestedCompanyId: "company-b" },
        },
        { id: "invocation-a", scope: { companyId: "company-a" } },
      );
      const companyAExpectation = expect(companyARequest).rejects.toThrow(
        /requested company "company-b"/,
      );
      const companyBRequest = callWorker(
        "getData",
        {
          key: "probe",
          companyId: "company-b",
          params: { label: "b", requestedCompanyId: "company-b" },
        },
        { id: "invocation-b", scope: { companyId: "company-b" } },
      );

      await expect(companyBRequest).resolves.toEqual({
        label: "b",
        company: { id: "company-b" },
      });
      await companyAExpectation;

      expect(nestedInvocationIds).toEqual(["invocation-b", "invocation-a"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});

describe("worker SPS Runtime transport", () => {
  it("forwards only the public SPS operations and keeps ctx.sps compatible", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const outboundMethods: string[] = [];
    let nextRequestId = 1;

    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("transport", async () => {
          const result = await ctx.spsTransport.request("sps.runtimes.list", {
            companyId: "company-1",
            nodeId: "node-1",
          });
          return { result };
        });
        ctx.actions.register("legacy", async () => ({
          result: await ctx.sps.runtimes.list("company-1", { nodeId: "node-1" }),
        }));
        ctx.actions.register("unsupported", async () => {
          const unsafeTransport = ctx.spsTransport as unknown as {
            request(operation: string, input: Record<string, unknown>): Promise<unknown>;
          };
          return unsafeTransport.request("companies.list", {});
        });
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    function callWorker(method: string, params: unknown) {
      const id = `host-sps-runtime-${nextRequestId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) {
            reject(new Error(response.error.message));
            return;
          }
          resolve((response as { result?: unknown }).result);
        });
      });
      hostToWorker.write(serializeMessage(createRequest(method, params, id)));
      return result;
    }

    hostReadline.on("line", (line) => {
      const message = parseMessage(line);
      if (isJsonRpcResponse(message)) {
        pending.get(String(message.id))?.(message);
        pending.delete(String(message.id));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      outboundMethods.push(message.method);
      if (message.method === "sps.runtimes.list") {
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, [{
          id: "runtime-1",
          nodeId: "node-1",
        }])));
      }
    });

    try {
      await expect(callWorker("initialize", {
        manifest: {
          id: "sps.runtime-transport-test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "SPS Runtime Transport Test",
          description: "Test plugin",
          author: "SPS",
          categories: ["automation"],
          capabilities: ["sps.runtimes.read"],
          entrypoints: {},
        },
        config: {},
        databaseNamespace: null,
      })).resolves.toMatchObject({ ok: true });

      await expect(callWorker("performAction", { key: "transport", params: {} })).resolves.toEqual({
        result: [{ id: "runtime-1", nodeId: "node-1" }],
      });
      await expect(callWorker("performAction", { key: "legacy", params: {} })).resolves.toEqual({
        result: [{ id: "runtime-1", nodeId: "node-1" }],
      });
      expect(outboundMethods).toEqual(["sps.runtimes.list", "sps.runtimes.list"]);

      await expect(callWorker("performAction", { key: "unsupported", params: {} }))
        .rejects.toThrow(/Unsupported SPS Runtime operation/);
      expect(outboundMethods).toEqual(["sps.runtimes.list", "sps.runtimes.list"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
