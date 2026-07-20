import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  spsAgentNodeBindings,
  spsNodeAgentGrants,
  spsNodeCommandEvents,
  spsNodeCommands,
  spsNodes,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  resolveSpsNodeExecutionTarget,
  SpsNodeExecutionUnavailableError,
} from "./sps-node-execution.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type SpsNodeCapability = NonNullable<(typeof spsNodes.$inferInsert)["capabilities"]>[number];
const REMOTE_CLI_RUNTIME_CASES = [
  ["claude_local", "claude_cli", "Claude Code"],
  ["gemini_local", "gemini_cli", "Gemini CLI"],
  ["pi_local", "pi_cli", "Pi CLI"],
] as const satisfies ReadonlyArray<readonly [string, SpsNodeCapability["kind"], string]>;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describeEmbeddedPostgres("SPS Node execution target", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-node-execution-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(spsNodeCommandEvents);
    await db.delete(spsNodeCommands);
    await db.delete(spsAgentNodeBindings);
    await db.delete(spsNodeAgentGrants);
    await db.delete(spsNodes);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture(input: {
    adapterType?: string;
    capabilities?: SpsNodeCapability[];
  } = {}) {
    const company = await db
      .insert(companies)
      .values({
        name: `SPS Node execution ${randomUUID()}`,
        issuePrefix: `SE${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Remote Codex",
        role: "engineer",
        adapterType: input.adapterType ?? "codex_local",
      })
      .returning()
      .then((rows) => rows[0]!);
    const node = await db
      .insert(spsNodes)
      .values({
        companyId: company.id,
        ownerUserId: "member-user",
        displayName: "Friend PC",
        publicKey: "test-ed25519-public-key",
        platform: "win32",
        status: "active",
        keyVerifiedAt: new Date(),
        lastSeenAt: new Date(),
        capabilities: input.capabilities ?? [{ kind: "codex_cli", label: "Codex CLI" }],
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(spsNodeAgentGrants).values({
      companyId: company.id,
      nodeId: node.id,
      agentId: agent.id,
      grantedByUserId: "owner-user",
    });
    await db.insert(spsAgentNodeBindings).values({
      companyId: company.id,
      nodeId: node.id,
      agentId: agent.id,
      assignedByUserId: "owner-user",
    });
    return { company, agent, node };
  }

  it("queues an Agent command for its approved Node and returns ordered Node output", async () => {
    const fixture = await createFixture();
    const target = await resolveSpsNodeExecutionTarget({
      db,
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      adapterType: "codex_local",
      heartbeatRunId: null,
      projectId: null,
    });
    expect(target?.transport).toBe("sps_node");
    expect(target?.remoteCwd).toBe(`sps-agent://${fixture.agent.id}`);
    const observedLogs: Array<{ stream: string; body: string }> = [];
    const pendingResult = target!.runner.execute({
      command: "codex",
      args: ["exec", "--json"],
      cwd: "C:/not-sent-to-node",
      env: { SAFE_VALUE: "1" },
      stdin: "prompt",
      timeoutMs: 5_000,
      onLog: async (stream, body) => { observedLogs.push({ stream, body }); },
    });

    let queued: typeof spsNodeCommands.$inferSelect | null = null;
    for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
      queued = await db
        .select()
        .from(spsNodeCommands)
        .where(and(eq(spsNodeCommands.companyId, fixture.company.id), eq(spsNodeCommands.agentId, fixture.agent.id)))
        .then((rows) => rows[0] ?? null);
      if (!queued) await wait(25);
    }
    expect(queued).not.toBeNull();
    expect(queued?.nodeId).toBe(fixture.node.id);
    expect(queued?.projectId).toBeNull();
    expect(queued?.env).toEqual({ SAFE_VALUE: "1" });
    expect(queued?.stdin).toBe("prompt");

    await db.insert(spsNodeCommandEvents).values({
      commandId: queued!.id,
      sequence: 1,
      stream: "stdout",
      body: "hello from friend node\n",
    });
    await db
      .update(spsNodeCommands)
      .set({ status: "succeeded", exitCode: 0, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(spsNodeCommands.id, queued!.id));

    await expect(pendingResult).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hello from friend node\n",
      stderr: "",
    });
    expect(observedLogs).toEqual([{ stream: "stdout", body: "hello from friend node\n" }]);
  });

  it("fails the Hub execution when a Node reports a failed command", async () => {
    const fixture = await createFixture();
    const target = await resolveSpsNodeExecutionTarget({
      db,
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      adapterType: "codex_local",
      heartbeatRunId: null,
      projectId: null,
    });
    const observedLogs: Array<{ stream: string; body: string }> = [];
    const pendingResult = target!.runner.execute({
      command: "codex",
      args: ["exec", "--json"],
      cwd: "C:/not-sent-to-node",
      env: {},
      stdin: "prompt",
      timeoutMs: 5_000,
      onLog: async (stream, body) => { observedLogs.push({ stream, body }); },
    });

    let queued: typeof spsNodeCommands.$inferSelect | null = null;
    for (let attempt = 0; attempt < 20 && !queued; attempt += 1) {
      queued = await db
        .select()
        .from(spsNodeCommands)
        .where(and(eq(spsNodeCommands.companyId, fixture.company.id), eq(spsNodeCommands.agentId, fixture.agent.id)))
        .then((rows) => rows[0] ?? null);
      if (!queued) await wait(25);
    }
    expect(queued).not.toBeNull();
    await db
      .update(spsNodeCommands)
      .set({
        status: "failed",
        error: "Selected Codex profile is not signed in on this SPS Desktop Node.",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(spsNodeCommands.id, queued!.id));

    await expect(pendingResult).rejects.toThrow(/Selected Codex profile is not signed in/);
    expect(observedLogs).toEqual([{
      stream: "stderr",
      body: "Selected Codex profile is not signed in on this SPS Desktop Node.\n",
    }]);
  });

  it("refuses a primary Node that lacks the required local runtime", async () => {
    const fixture = await createFixture();
    await expect(resolveSpsNodeExecutionTarget({
      db,
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      adapterType: "sps_ollama_local",
      heartbeatRunId: null,
      projectId: null,
    })).rejects.toBeInstanceOf(SpsNodeExecutionUnavailableError);
  });

  it.each(REMOTE_CLI_RUNTIME_CASES)("accepts the advertised runtime for %s", async (adapterType, capabilityKind, label) => {
    const fixture = await createFixture({
      adapterType,
      capabilities: [{ kind: capabilityKind, label }],
    });
    await expect(resolveSpsNodeExecutionTarget({
      db,
      companyId: fixture.company.id,
      agentId: fixture.agent.id,
      adapterType,
      heartbeatRunId: null,
      projectId: null,
    })).resolves.toMatchObject({ transport: "sps_node", nodeId: fixture.node.id });
  });
});
