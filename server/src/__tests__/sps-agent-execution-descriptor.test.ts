import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, spsAgentNodeBindings, spsNodeCommands, spsNodes } from "@paperclipai/db";
import { describeSpsAgentExecution } from "../services/sps-agent-execution-descriptor.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
describeDb("safe Agent execution descriptors", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("sps-agent-descriptor-"); db = createDb(temporary.connectionString); }, 30_000);
  afterEach(async () => { await db.delete(agents); await db.delete(companies); });
  afterAll(async () => { await temporary?.cleanup(); });
  async function company() {
    return (await db.insert(companies).values({ name: "Descriptor fixture", issuePrefix: `DE${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}` }).returning())[0]!;
  }
  async function agent(companyId: string, adapterType = "codex_local", status = "idle") {
    return (await db.insert(agents).values({ companyId, name: "Do not copy workflow role", role: "engineer", adapterType, status,
      adapterConfig: { token: "private-token", cwd: "C:/private-folder", baseUrl: "https://private.example" }, runtimeConfig: { env: { PRIVATE: "private-env" } },
    }).returning())[0]!;
  }
  async function bind(agentId: string, companyId: string, nodeCompanyId = companyId) {
    const [node] = await db.insert(spsNodes).values({ companyId: nodeCompanyId, ownerUserId: "private-owner", publicKey: "private-key-material", displayName: "private-device", platform: "win32",
      status: "active", keyVerifiedAt: new Date(), lastSeenAt: new Date(),
    }).returning();
    await db.insert(spsAgentNodeBindings).values({ companyId, agentId, nodeId: node!.id, assignedByUserId: "fixture" });
    return node!;
  }
  it("returns configuration and registration without loading secrets, probing or running an Agent", async () => {
    const workspace = await company(); const entry = await agent(workspace.id);
    const registered = vi.fn(() => true);
    const result = await describeSpsAgentExecution(db, { agentId: entry.id, companyId: workspace.id }, registered);
    expect(result).toEqual({ agentId: entry.id, adapterType: "codex_local", state: "configured", adapterRegistration: "registered",
      executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null });
    expect(registered).toHaveBeenCalledExactlyOnceWith("codex_local");
    expect(JSON.stringify(result)).not.toMatch(/private|cwd|token|env|https|engineer/);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    expect(await db.select().from(spsNodeCommands)).toEqual([]);
  });
  it("does not convert paused, missing or unknown adapter configuration into readiness", async () => {
    const workspace = await company(); const entry = await agent(workspace.id, "not_registered", "paused");
    expect(await describeSpsAgentExecution(db, { agentId: entry.id, companyId: workspace.id }, () => false)).toMatchObject({ state: "disabled", adapterRegistration: "unavailable", readiness: "unknown" });
    await db.update(agents).set({ adapterType: "C:/private-token", status: "unexpected" }).where(eq(agents.id, entry.id));
    const registered = vi.fn(() => true);
    expect(await describeSpsAgentExecution(db, { agentId: entry.id, companyId: workspace.id }, registered)).toMatchObject({ adapterType: "unknown", state: "unknown", adapterRegistration: "unavailable" });
    expect(registered).not.toHaveBeenCalled();
  });
  it("uses cached Node approval and heartbeat but never claims an Agent grant or credential is ready", async () => {
    const workspace = await company(); const entry = await agent(workspace.id); const node = await bind(entry.id, workspace.id);
    const inspect = () => describeSpsAgentExecution(db, { agentId: entry.id, companyId: workspace.id }, () => true);
    expect(await inspect()).toMatchObject({ executionOwner: "node", readiness: "unknown", authorization: "recheck_on_dispatch", node: { id: node.id, state: "recently_seen" } });
    await db.update(spsNodes).set({ status: "revoked" }).where(eq(spsNodes.id, node.id));
    expect(await inspect()).toMatchObject({ executionOwner: "node", node: { state: "inactive" }, readiness: "unknown" });
    await db.update(spsNodes).set({ status: "active", lastSeenAt: new Date(Date.now() + 60_000) }).where(eq(spsNodes.id, node.id));
    expect(await inspect()).toMatchObject({ node: { state: "unknown", observedAt: null } });
    expect(await db.select().from(spsNodeCommands)).toEqual([]);
  });
  it("does not reveal another Workspace Agent or Node through inconsistent bindings", async () => {
    const a = await company(), b = await company(); const entry = await agent(a.id); await bind(entry.id, a.id, b.id);
    const registered = vi.fn(() => true);
    expect(await describeSpsAgentExecution(db, { agentId: entry.id, companyId: a.id }, registered)).toMatchObject({ executionOwner: "node", node: { id: null, state: "unknown", observedAt: null } });
    await expect(describeSpsAgentExecution(db, { agentId: entry.id, companyId: b.id }, registered)).rejects.toThrow("Agent not found");
    await expect(describeSpsAgentExecution(db, { agentId: randomUUID(), companyId: a.id }, registered)).rejects.toThrow("Agent not found");
    expect(registered).toHaveBeenCalledTimes(1);
  });
});
