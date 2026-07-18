import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  companies,
  agents,
  issues,
  issueComments,
  activityLog,
  issueRecoveryActions,
  heartbeatRuns,
  agentWakeupRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  normalizeIssueExecutionPolicy,
  parseIssueExecutionFailurePolicy,
  stripMonitorFromExecutionPolicy,
} from "../services/issue-execution-policy.js";
import { recoveryService } from "../services/recovery/service.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("IssueExecutionFailurePolicy Unit Tests", () => {
  it("normalizeIssueExecutionPolicy keeps a failure-only policy and applies defaults for omitted booleans", () => {
    const input = {
      failure: {
        automaticRetry: false,
      },
    };
    const normalized = normalizeIssueExecutionPolicy(input);
    expect(normalized).not.toBeNull();
    expect(normalized!.failure).toEqual({
      automaticRetry: false,
      preserveAssignee: false,
      wakeRecoveryOwner: true,
    });

    const input2 = {
      failure: {},
    };
    const normalized2 = normalizeIssueExecutionPolicy(input2);
    expect(normalized2).not.toBeNull();
    expect(normalized2!.failure).toEqual({
      automaticRetry: true,
      preserveAssignee: false,
      wakeRecoveryOwner: true,
    });
  });

  it("parseIssueExecutionFailurePolicy returns existing defaults for null/malformed legacy data", () => {
    const defaults = {
      automaticRetry: true,
      preserveAssignee: false,
      wakeRecoveryOwner: true,
    };
    expect(parseIssueExecutionFailurePolicy(null)).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy(undefined)).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy("malformed")).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy([])).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy({})).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy({ failure: null })).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy({ failure: "string" })).toEqual(defaults);
    expect(parseIssueExecutionFailurePolicy({ failure: [] })).toEqual(defaults);
  });

  it("stripMonitorFromExecutionPolicy preserves failure when removing monitor", () => {
    const policy = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: "2026-07-13T12:00:00Z",
        notes: "test notes",
        scheduledBy: "assignee" as const,
        kind: null,
        serviceName: null,
        externalRef: null,
        timeoutAt: null,
        maxAttempts: null,
        recoveryPolicy: null,
      },
      failure: {
        automaticRetry: false,
        preserveAssignee: true,
        wakeRecoveryOwner: false,
      },
    };
    const stripped = stripMonitorFromExecutionPolicy(policy);
    expect(stripped).not.toBeNull();
    expect(stripped!.monitor).toBeUndefined();
    expect(stripped!.failure).toEqual({
      automaticRetry: false,
      preserveAssignee: true,
      wakeRecoveryOwner: false,
    });
  });
});

const externalPostgresUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim() || null;
if (externalPostgresUrl) {
  const databaseName = new URL(externalPostgresUrl).pathname.slice(1);
  if (!databaseName.toLowerCase().includes("test")) {
    throw new Error("PAPERCLIP_TEST_DATABASE_URL must name a test-only database");
  }
}
const embeddedPostgresSupport = externalPostgresUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describePostgres("IssueExecutionFailurePolicy DB integration tests", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalPostgresUrl) {
      await applyPendingMigrations(externalPostgresUrl);
      db = createDb(externalPostgresUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-failure-policy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Clean up in FK-safe order: child-first, parent-last
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.update(agents).set({ reportsTo: null });
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgents() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Failure Company",
      issuePrefix: "TFAIL",
      requireBoardApprovalForNewAgents: false,
    });

    const managerId = randomUUID();
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "ManagerAgent",
      role: "general",
      status: "active",
      reportsTo: null,
    });

    const workerId = randomUUID();
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "WorkerAgent",
      role: "general",
      status: "active",
      reportsTo: managerId,
    });

    return { companyId, managerId, workerId };
  }

  it("escalateStrandedAssignedIssue with failure policy { automaticRetry: false, preserveAssignee: true, wakeRecoveryOwner: false }", async () => {
    const { companyId, managerId, workerId } = await seedCompanyAndAgents();

    const issueId = randomUUID();
    const issueIdentifier = "TFAIL-1";

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue 1",
      status: "in_progress",
      assigneeAgentId: workerId,
      identifier: issueIdentifier,
      executionPolicy: {
        failure: {
          automaticRetry: false,
          preserveAssignee: true,
          wakeRecoveryOwner: false,
        },
      },
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));

    const latestRun = {
      id: randomUUID(),
      agentId: workerId,
      status: "failed" as const,
      error: "Run failed",
      errorCode: "process_loss" as const,
      contextSnapshot: { issueId },
      livenessState: "failed" as const,
    };

    await db.insert(heartbeatRuns).values({
      id: latestRun.id,
      companyId,
      agentId: workerId,
      status: "failed",
      error: "Run failed",
      errorCode: "process_loss",
      contextSnapshot: { issueId },
      livenessState: "failed",
    });

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(updated).not.toBeNull();

    // Verify recovery action
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0].ownerAgentId).toBe(managerId);
    expect(actions[0].wakePolicy).toEqual({
      type: "record_only",
      reason: "wake_recovery_owner_disabled_by_policy",
      ownerAgentId: managerId,
    });

    // Verify issue is blocked while keeping worker as assignee
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue.status).toBe("blocked");
    expect(updatedIssue.assigneeAgentId).toBe(workerId);

    // Verify comment
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].authorType).toBe("system");

    // Verify activity
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(logs.length).toBeGreaterThan(0);

    // Verify enqueueWakeup was never called
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("escalateStrandedAssignedIssue without failure policy (default behavior)", async () => {
    const { companyId, managerId, workerId } = await seedCompanyAndAgents();

    const issueId = randomUUID();
    const issueIdentifier = "TFAIL-2";

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue 2",
      status: "in_progress",
      assigneeAgentId: workerId,
      identifier: issueIdentifier,
      executionPolicy: null,
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));

    const latestRun = {
      id: randomUUID(),
      agentId: workerId,
      status: "failed" as const,
      error: "Run failed",
      errorCode: "process_loss" as const,
      contextSnapshot: { issueId },
      livenessState: "failed" as const,
    };

    await db.insert(heartbeatRuns).values({
      id: latestRun.id,
      companyId,
      agentId: workerId,
      status: "failed",
      error: "Run failed",
      errorCode: "process_loss",
      contextSnapshot: { issueId },
      livenessState: "failed",
    });

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue,
      previousStatus: "in_progress",
      latestRun,
    });

    expect(updated).not.toBeNull();

    // Verify issue is blocked and assigned to recovery owner (manager)
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue.status).toBe("blocked");
    expect(updatedIssue.assigneeAgentId).toBe(managerId);

    // Verify enqueueWakeup was called
    expect(enqueueWakeup).toHaveBeenCalledWith(managerId, expect.any(Object));
  });

  it("heartbeatService(db).reconcileStrandedAssignedIssues() with failure policy automaticRetry=false", async () => {
    const { companyId, managerId, workerId } = await seedCompanyAndAgents();

    const issueId = randomUUID();
    const issueIdentifier = "TFAIL-3";

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue 3",
      status: "in_progress",
      assigneeAgentId: workerId,
      identifier: issueIdentifier,
      executionPolicy: {
        failure: {
          automaticRetry: false,
          preserveAssignee: true,
          wakeRecoveryOwner: false,
        },
      },
    });

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: workerId,
      status: "failed",
      error: "Failed run",
      errorCode: "process_loss",
      contextSnapshot: { issueId },
      livenessState: "failed",
      createdAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.dispatchRequeued).toBe(0);

    // Verify no retry run or wakeup was created
    const allRuns = await db.select().from(heartbeatRuns);
    expect(allRuns).toHaveLength(1); // Only the seeded failed run

    const wakeupRequests = await db.select().from(agentWakeupRequests);
    expect(wakeupRequests).toHaveLength(0);

    // Verify issue is blocked with worker preserved
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue.status).toBe("blocked");
    expect(updatedIssue.assigneeAgentId).toBe(workerId);

    // Verify action is record_only
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0].ownerAgentId).toBe(managerId);
    expect(actions[0].wakePolicy).toEqual({
      type: "record_only",
      reason: "wake_recovery_owner_disabled_by_policy",
      ownerAgentId: managerId,
    });
  });
});
