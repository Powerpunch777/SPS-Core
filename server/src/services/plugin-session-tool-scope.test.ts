import { describe, expect, it, vi } from "vitest";
import type { Db } from "../compat/paperclip/db.js";
import { resolvePluginSessionToolScope } from "./plugin-session-tool-scope.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const input = { companyId, agentId, runId };
const agent = { companyId, status: "running" };
const taskKey = "plugin:local.example:session:conversation";
const conversation = { pluginKey: "local.example", sessionId, message: "Use the plugin tools." };
const run = { agentId, companyId, status: "running", contextSnapshot: { taskKey, spsPluginConversation: conversation } };
const session = { id: sessionId, agentId, companyId, taskKey, status: "active", closedAt: null };

function database(rows: unknown[][]) {
  return { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [] }) }) })) } as unknown as Db;
}

describe("projectless plugin session tool scope", () => {
  it("accepts only the owned active session and returns its plugin key", async () => {
    expect(await resolvePluginSessionToolScope(database([[agent], [run], [session]]), input)).toBe("local.example");
  });
  it("rejects malformed identifiers before database access", async () => {
    const db = database([]);
    expect(await resolvePluginSessionToolScope(db, { ...input, agentId: "invalid" })).toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
  it.each(["queued", "succeeded", "cancelled", "failed"])("rejects a %s run", async status => {
    expect(await resolvePluginSessionToolScope(database([[agent], [{ ...run, status }], [session]]), input)).toBeNull();
  });
  it.each([
    ["foreign Agent", [{ ...agent, companyId: "other" }], [run], [session]],
    ["paused Agent", [{ ...agent, status: "paused" }], [run], [session]],
    ["cancelled intent", [agent], [{ ...run, contextSnapshot: { ...run.contextSnapshot, spsSessionCancellationRequested: true } }], [session]],
    ["foreign run Agent", [{ companyId }], [{ ...run, agentId: "other" }], [session]],
    ["foreign run Workspace", [{ companyId }], [{ ...run, companyId: "other" }], [session]],
    ["missing context", [{ companyId }], [{ ...run, contextSnapshot: {} }], [session]],
    ["mismatched plugin", [{ companyId }], [{ ...run, contextSnapshot: { taskKey, spsPluginConversation: { ...conversation, pluginKey: "other" } } }], [session]],
    ["foreign session Agent", [{ companyId }], [run], [{ ...session, agentId: "other" }]],
    ["foreign session Workspace", [{ companyId }], [run], [{ ...session, companyId: "other" }]],
    ["foreign session id", [{ companyId }], [run], [{ ...session, id: runId }]],
    ["mismatched task key", [{ companyId }], [run], [{ ...session, taskKey: `${taskKey}-other` }]],
    ["closed session", [{ companyId }], [run], [{ ...session, status: "closed" }]],
    ["session closure timestamp", [{ companyId }], [run], [{ ...session, closedAt: new Date() }]],
    ["missing session", [{ companyId }], [run], []],
  ])("rejects %s", async (_label, agents, runs, sessions) => {
    const scopedAgents = (agents as Record<string, unknown>[]).map(row => ({ ...agent, ...row }));
    expect(await resolvePluginSessionToolScope(database([scopedAgents, runs, sessions]), input)).toBeNull();
  });
});
