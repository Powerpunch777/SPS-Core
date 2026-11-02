import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import type { HostServices } from "../src/host-client-factory.js";
import { createHostClientHandlers } from "../src/host-client-factory.js";
import {
  createRequest,
  createSuccessResponse,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

describe("agent session policy SDK plumbing", () => {
  it("serializes an execution policy and leaves ordinary sends unchanged", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const pending = new Map<string, (response: JsonRpcResponse) => void>();
    const outbound: Array<{ method: string; params: unknown }> = [];
    let nextId = 1;
    const plugin = definePlugin({
      async setup(ctx) {
        ctx.actions.register("send", async (params) => {
          const { executionPolicy } = params as { executionPolicy?: { mode: "plugin-tools-only-v1"; toolNames: readonly string[] } };
          return ctx.agents.sessions.sendMessage("session-1", "company-1", {
            prompt: "hello",
            ...(executionPolicy ? { executionPolicy } : {}),
          });
        });
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    function callWorker(method: string, params: unknown): Promise<unknown> {
      const id = `test-${nextId++}`;
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, (response) => {
          if ("error" in response && response.error) reject(new Error(response.error.message));
          else resolve((response as { result?: unknown }).result);
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
      } else if (isJsonRpcRequest(message)) {
        outbound.push({ method: message.method, params: message.params });
        hostToWorker.write(serializeMessage(createSuccessResponse(message.id, { runId: "run-1" })));
      }
    });

    try {
      await callWorker("initialize", {
        manifest: {
          id: "test.policy-plumbing", apiVersion: 1, version: "1.0.0",
          displayName: "Policy Plumbing", description: "SDK plumbing test", author: "test",
          categories: ["automation"], capabilities: ["agent.sessions.send"], entrypoints: {},
        },
        config: {}, databaseNamespace: null,
      });
      const policy = { mode: "plugin-tools-only-v1" as const, toolNames: ["paperclip.test.lookup"] };
      await callWorker("performAction", { key: "send", params: { executionPolicy: policy } });
      await callWorker("performAction", { key: "send", params: {} });

      expect(outbound).toEqual([
        { method: "agents.sessions.sendMessage", params: { sessionId: "session-1", companyId: "company-1", prompt: "hello", executionPolicy: policy } },
        { method: "agents.sessions.sendMessage", params: { sessionId: "session-1", companyId: "company-1", prompt: "hello" } },
      ]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("gates policy support discovery and fails explicitly on an older Host", async () => {
    const params = { sessionId: "session-1", companyId: "company-1" };
    const oldHost = createHostClientHandlers({
      pluginId: "test.policy-plumbing",
      capabilities: ["agent.sessions.read"],
      services: { agentSessions: {} } as unknown as HostServices,
    });
    await expect(oldHost["agents.sessions.describePolicySupport"](params))
      .rejects.toThrow("does not support agent session policy support discovery");

    const describePolicySupport = async () => ({
      schemaVersion: 1 as const,
      modes: ["plugin-tools-only-v1"] as const,
      enforcement: "dispatch-and-run" as const,
      readiness: "unknown" as const,
      osIsolation: "not-certified" as const,
    });
    const host = createHostClientHandlers({
      pluginId: "test.policy-plumbing",
      capabilities: ["agent.sessions.read"],
      services: { agentSessions: { describePolicySupport } } as unknown as HostServices,
    });
    await expect(host["agents.sessions.describePolicySupport"](params)).resolves.toEqual(await describePolicySupport());

    const denied = createHostClientHandlers({
      pluginId: "test.policy-plumbing",
      capabilities: [],
      services: { agentSessions: { describePolicySupport } } as unknown as HostServices,
    });
    await expect(denied["agents.sessions.describePolicySupport"](params)).rejects.toThrow(/agent\.sessions\.read/);
  });
});
