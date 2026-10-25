import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, spsNodes, spsNodeRunnerProfiles, spsPluginExecutionGrants, spsPluginNodeRuns } from "@paperclipai/db";
import { spsPluginExecutionService } from "../services/sps-plugin-execution.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("SPS safe runtime discovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("sps-runtime-discovery-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterEach(async () => { await db.delete(companies); });
  afterAll(async () => { await temporary?.cleanup(); });

  async function company() {
    return (await db.insert(companies).values({ name: "Runtime discovery", issuePrefix: `RD${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}` }).returning())[0]!;
  }
  async function runtime(companyId: string, options: {
    status?: string; verified?: boolean; lastSeenAt?: Date | null; runnerCompanyId?: string; kind?: string;
    credentialStatus?: string; availabilityStatus?: string;
  } = {}) {
    const node = (await db.insert(spsNodes).values({
      companyId, ownerUserId: "fixture-owner", publicKey: `test-key-${randomUUID()}`,
      displayName: "Fixture Node", platform: "win32", status: options.status ?? "active",
      keyVerifiedAt: options.verified === false ? null : new Date(),
      lastSeenAt: options.lastSeenAt === undefined ? new Date() : options.lastSeenAt,
    }).returning())[0]!;
    const runner = (await db.insert(spsNodeRunnerProfiles).values({
      companyId: options.runnerCompanyId ?? companyId, nodeId: node.id, runnerKey: "fixture-runner",
      kind: options.kind ?? "codex_cli", label: "Fixture CLI",
      credentialStatus: options.credentialStatus ?? "unknown", availabilityStatus: options.availabilityStatus ?? "unknown",
    }).returning())[0]!;
    return { node, runner };
  }

  it("reads Node metadata without an Agent, execution grant, command or live provider probe", async () => {
    const workspace = await company();
    const { node, runner } = await runtime(workspace.id);
    const service = spsPluginExecutionService(db, "sps.discovery-fixture");
    const result = await service.listRuntimes({ companyId: workspace.id });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: runner.id, nodeId: node.id, online: true,
      connection: { executionOwner: "node", authorization: "execution_grant_required", state: "recently_seen", observedAt: node.lastSeenAt!.toISOString() },
    });
    expect(await service.listRuntimes({ companyId: workspace.id, nodeId: randomUUID() })).toEqual([]);
    expect(await db.select().from(spsPluginExecutionGrants)).toEqual([]);
    expect(await db.select().from(spsPluginNodeRuns)).toEqual([]);
    expect(result[0]).not.toHaveProperty("publicKey");
    expect(result[0]).not.toHaveProperty("ownerUserId");
  });

  it("does not equate a recent Node heartbeat with runner credentials or execution readiness", async () => {
    const workspace = await company();
    const { node, runner } = await runtime(workspace.id, { credentialStatus: "auth_required", availabilityStatus: "quota_limited" });
    const service = spsPluginExecutionService(db, "sps.discovery-fixture");
    const [listed] = await service.listRuntimes({ companyId: workspace.id });
    expect(listed).toMatchObject({ online: true, credentialStatus: "auth_required", availabilityStatus: "quota_limited", connection: { state: "recently_seen", authorization: "execution_grant_required" } });
    const grant = await service.upsertExecutionGrant({ companyId: workspace.id, subjectKey: "fixture", nodeId: node.id, runnerProfileId: runner.id });
    await expect(service.dispatchRun({ companyId: workspace.id, executionGrantId: grant.id, args: [] })).rejects.toThrow("not ready");
    expect(await service.listRuns({ companyId: workspace.id })).toEqual([]);
  });

  it("projects revoked, unverified, stale and future observations without a false online claim", async () => {
    const workspace = await company();
    const cases = [
      { options: { status: "revoked" }, state: "inactive" },
      { options: { verified: false }, state: "unverified" },
      { options: { lastSeenAt: new Date(Date.now() - 180_000) }, state: "offline" },
      { options: { lastSeenAt: new Date(Date.now() + 60_000) }, state: "unknown" },
      { options: { lastSeenAt: null }, state: "unknown" },
    ];
    const expected = new Map<string, string>();
    for (const item of cases) expected.set((await runtime(workspace.id, item.options)).runner.id, item.state);
    const result = await spsPluginExecutionService(db, "sps.discovery-fixture").listRuntimes({ companyId: workspace.id });
    expect(result).toHaveLength(cases.length);
    for (const item of result) {
      expect(item.online).toBe(false);
      expect(item.connection.state).toBe(expected.get(item.id));
    }
  });

  it("does not reveal a foreign Workspace Node through an inconsistent Runner association", async () => {
    const a = await company(), b = await company();
    await runtime(b.id, { runnerCompanyId: a.id });
    const service = spsPluginExecutionService(db, "sps.discovery-fixture");
    expect(await service.listRuntimes({ companyId: a.id })).toEqual([]);
    expect(await service.listRuntimes({ companyId: b.id })).toEqual([]);
  });

  it("does not pretend arbitrary or API-only profiles are approved direct CLI backends", async () => {
    const workspace = await company();
    await runtime(workspace.id, { kind: "custom" });
    await runtime(workspace.id, { kind: "specialist_api" });
    expect(await spsPluginExecutionService(db, "sps.discovery-fixture").listRuntimes({ companyId: workspace.id })).toEqual([]);
  });

  it("rejects dispatch with a future heartbeat rather than treating it as fresh", async () => {
    const workspace = await company();
    const { node, runner } = await runtime(workspace.id, { lastSeenAt: new Date(Date.now() + 60_000) });
    const service = spsPluginExecutionService(db, "sps.discovery-fixture");
    const grant = await service.upsertExecutionGrant({ companyId: workspace.id, subjectKey: "fixture", nodeId: node.id, runnerProfileId: runner.id });
    await expect(service.dispatchRun({ companyId: workspace.id, executionGrantId: grant.id, args: [] })).rejects.toThrow("heartbeat freshness is unknown");
    expect(await service.listRuns({ companyId: workspace.id })).toEqual([]);
  });
});
