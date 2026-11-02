import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { parseSpsSessionExecutionPolicy } from "@paperclipai/adapter-utils/sps-session-policy";
import { describeSpsSessionPolicySupport } from "../services/sps-session-policy.js";
import { validateSessionDispatch } from "../services/sps-session-dispatches.js";
import { createSpsSessionDispatchContext } from "../services/sps-session-dispatch-context.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const pluginKey = "sps.test";
const session = { id: sessionId, companyId, agentId, userId: null, status: "active", closedAt: null, taskKey: "plugin:sps.test:session:one" };
const agent = { id: agentId, status: "idle", adapterType: "codex_local" };
function database(rows: unknown[][]) {
  return { select: vi.fn(() => ({ from: () => ({ where: async () => rows.shift() ?? [] }) })) } as unknown as Db;
}
const input = { companyId, sessionId, pluginKey };

describe("restricted plugin session policy", () => {
  it("stored session metadata cannot overwrite run identity, prompt or policy", () => {
    const policy = { mode: "plugin-tools-only-v1" as const, toolNames: ["read"] };
    const context = createSpsSessionDispatchContext({ pluginKey, sessionId, taskKey: session.taskKey, prompt: "Exact prompt", requestId,
      executionPolicy: policy, sessionContext: { projectId: agentId, taskKey: "plugin:other:session:evil", wakeSource: "forged",
        spsPluginConversation: { pluginKey: "other", sessionId: agentId, message: "forged", executionPolicy: undefined } } });
    expect(context.projectId).toBe(agentId);
    expect(context.taskKey).toBe(session.taskKey);
    expect(context.wakeSource).toBe("automation");
    expect(context.spsPluginConversation).toEqual({ pluginKey, sessionId, message: "Exact prompt", requestId, executionPolicy: policy });
  });
  it("returns a detached canonical restriction, with no unrestricted fallback for invalid input", () => {
    expect(parseSpsSessionExecutionPolicy(undefined)).toBeNull();
    const original = { mode: "plugin-tools-only-v1", toolNames: ["builder.read-z", "builder.read-a"] };
    const policy = parseSpsSessionExecutionPolicy(original)!;
    original.toolNames[0] = "builder.modified";
    expect(policy.toolNames).toEqual(["builder.read-a", "builder.read-z"]);
    expect(Object.isFrozen(policy) && Object.isFrozen(policy.toolNames)).toBe(true);
    for (const invalid of [null, {}, { ...original, extra: true }, { mode: "unknown", toolNames: ["read"] },
      { mode: "plugin-tools-only-v1", toolNames: [] }, { mode: "plugin-tools-only-v1", toolNames: ["read", "read"] },
      { mode: "plugin-tools-only-v1", toolNames: ["other:read"] }, { mode: "plugin-tools-only-v1", toolNames: ["x".repeat(129)] },
      { mode: "plugin-tools-only-v1", toolNames: Array.from({ length: 33 }, (_, n) => `read-${n}`) },
    ]) expect(() => parseSpsSessionExecutionPolicy(invalid)).toThrow();
  });
  it("rejects getters, symbols and sparse arrays without invoking user code", () => {
    let calls = 0;
    const getter = { toolNames: ["read"], get mode() { calls += 1; return "plugin-tools-only-v1"; } };
    expect(() => parseSpsSessionExecutionPolicy(getter)).toThrow();
    const names = ["read"];
    Object.defineProperty(names, "0", { enumerable: true, get() { calls += 1; return "read"; } });
    expect(() => parseSpsSessionExecutionPolicy({ mode: "plugin-tools-only-v1", toolNames: names })).toThrow();
    expect(calls).toBe(0);
    expect(() => parseSpsSessionExecutionPolicy({ mode: "plugin-tools-only-v1", toolNames: new Array(1) })).toThrow();
    expect(() => parseSpsSessionExecutionPolicy({ mode: "plugin-tools-only-v1", toolNames: ["read"], [Symbol("extra")]: true })).toThrow();
  });
  it("binds durable request digests to the restriction while preserving exact legacy digests", () => {
    const send = { companyId, sessionId, requestId, prompt: "Read the assigned plan." };
    const legacy = createHash("sha256").update(JSON.stringify([sessionId, send.prompt, null])).digest("hex");
    expect(validateSessionDispatch(send)).toBe(legacy);
    const policy = { mode: "plugin-tools-only-v1" as const, toolNames: ["read-z", "read-a"] };
    expect(validateSessionDispatch({ ...send, executionPolicy: policy })).not.toBe(legacy);
    expect(validateSessionDispatch({ ...send, executionPolicy: policy })).toBe(validateSessionDispatch({ ...send,
      executionPolicy: { ...policy, toolNames: ["read-a", "read-z"] } }));
  });
  it("advertises configuration support without claiming readiness or exposing configuration", async () => {
    const db = database([[session], [agent], []]);
    const check = vi.fn(async () => {});
    expect(await describeSpsSessionPolicySupport(db, input, () => true, check)).toEqual({ schemaVersion: 1,
      modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" });
    expect(check).toHaveBeenCalledTimes(3);
  });
  it("does not advertise unsupported adapters, disabled Agents, missing registration or Node execution", async () => {
    for (const [entry, binding, registered] of [[{ ...agent, adapterType: "claude_local" }, [], true],
      [{ ...agent, status: "paused" }, [], true], [agent, [], false], [agent, [{ nodeId: "missing" }], true]] as const) {
      const result = await describeSpsSessionPolicySupport(database([[session], [entry], [...binding], []]), input, () => registered, async () => {});
      expect(result.modes).toEqual([]);
    }
  });
  it("hides foreign, closed, user-owned or differently-owned plugin sessions and rechecks authority", async () => {
    for (const row of [{ ...session, companyId: agentId }, { ...session, id: agentId }, { ...session, userId: "user" },
      { ...session, status: "closed" }, { ...session, closedAt: new Date() }, { ...session, taskKey: "plugin:sps.other:session:one" }]) {
      await expect(describeSpsSessionPolicySupport(database([[row]]), input, () => true, async () => {})).rejects.toThrow("unavailable");
    }
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("authority revoked"));
    await expect(describeSpsSessionPolicySupport(database([[session]]), input, () => true, check)).rejects.toThrow("authority revoked");
  });
});
