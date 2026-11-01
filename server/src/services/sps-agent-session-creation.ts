import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agents, agentTaskSessions, issues, projects, projectWorkspaces, type Db } from "../compat/paperclip/db.js";
import type { AgentSession } from "../compat/paperclip/plugin-sdk.js";
import type { AgentSessionContext } from "../compat/paperclip/shared.js";

type Input = { companyId: string; agentId: string; taskKey?: string; context?: AgentSessionContext };
type Agent = { companyId: string; adapterType: string };
type Session = typeof agentTaskSessions.$inferSelect;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function taskKeyFor(pluginKey: string, value: unknown): string {
  const prefix = `plugin:${pluginKey}:session:`;
  if (value === undefined) return `${prefix}${randomUUID()}`;
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.slice(prefix.length).trim()
    || Buffer.byteLength(value, "utf8") > 1_024 || /[\x00-\x1f\x7f\ufffd]/u.test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) {
    throw new Error("Session taskKey must be a bounded, non-empty key owned by this plugin");
  }
  return value;
}

function sessionDto(row: Session): AgentSession {
  return { sessionId: row.id, agentId: row.agentId, companyId: row.companyId,
    status: "active", createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    context: row.contextJson ?? undefined, lastRunId: row.lastRunId, lastError: row.lastError };
}

function sameContext(actual: unknown, expected: AgentSessionContext | null): boolean {
  if (actual === null) return expected === null;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const value = actual as Record<string, unknown>;
  const keys = ["projectId", "projectWorkspaceId", "issueId"] as const;
  if (Object.keys(value).some(key => !keys.some(allowed => allowed === key))) return false;
  return keys.every(key => value[key] === expected?.[key]);
}

export function spsAgentSessionCreationService(db: Db, pluginKey: string,
  loadAgent: (agentId: string) => Promise<Agent | null>, assertCurrent: (companyId: string) => Promise<void>) {
  async function contextFor(input: Input): Promise<AgentSessionContext | null> {
    if (!input.context) return null;
    const { projectId, projectWorkspaceId, issueId } = input.context;
    let validatedProjectId = projectId || null;
    if (projectId) {
      const project = await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, input.companyId)))
        .then(rows => rows[0] ?? null);
      if (!project) throw new Error("Project not found");
    }
    let workspaceProjectId: string | null = null;
    if (projectWorkspaceId) {
      const workspace = await db.select().from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId)))
        .then(rows => rows[0] ?? null);
      if (!workspace) throw new Error("Project workspace not found");
      workspaceProjectId = workspace.projectId;
    }
    let issueProjectId: string | null = null;
    if (issueId) {
      const issue = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
        .then(rows => rows[0] ?? null);
      if (!issue) throw new Error("Issue not found");
      issueProjectId = issue.projectId;
    }
    if (projectWorkspaceId && projectId && workspaceProjectId !== projectId) throw new Error("Workspace does not belong to the project");
    if (issueId && projectId && issueProjectId !== projectId) throw new Error("Issue does not belong to the project");
    if (!validatedProjectId) {
      if (workspaceProjectId && issueProjectId) {
        if (workspaceProjectId !== issueProjectId) throw new Error("Workspace and issue point to different projects");
        validatedProjectId = workspaceProjectId;
      } else validatedProjectId = workspaceProjectId || issueProjectId;
    }
    const context: AgentSessionContext = {};
    if (validatedProjectId) context.projectId = validatedProjectId;
    if (projectWorkspaceId) context.projectWorkspaceId = projectWorkspaceId;
    if (issueId) context.issueId = issueId;
    return Object.keys(context).length ? context : null;
  }

  async function create(input: Input): Promise<AgentSession> {
    await assertCurrent(input.companyId);
    const taskKey = taskKeyFor(pluginKey, input.taskKey);
    const agent = await loadAgent(input.agentId);
    await assertCurrent(input.companyId);
    if (!agent || agent.companyId !== input.companyId) throw new Error("Agent not found");
    const contextJson = await contextFor(input);
    await assertCurrent(input.companyId);
    const row = await db.transaction(async tx => {
      const current = await tx.select({ adapterType: agents.adapterType }).from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update").then(rows => rows[0]);
      await assertCurrent(input.companyId);
      if (!current) throw new Error("Agent not found");
      const created = await tx.insert(agentTaskSessions).values({ companyId: input.companyId, agentId: input.agentId,
        adapterType: current.adapterType, taskKey, sessionParamsJson: null, sessionDisplayId: null,
        contextJson, lastRunId: null, lastError: null }).returning().then(rows => rows[0]!);
      await assertCurrent(input.companyId);
      return created;
    });
    await assertCurrent(input.companyId);
    return sessionDto(row);
  }

  async function ensure(input: Input & { taskKey: string; expectedSessionId?: string }): Promise<{ sessionId: string; created: boolean }> {
    await assertCurrent(input.companyId);
    if (typeof input.taskKey !== "string") throw new Error("A stable session taskKey is required");
    if (input.expectedSessionId !== undefined && (typeof input.expectedSessionId !== "string" || !uuid.test(input.expectedSessionId))) {
      throw new Error("Expected session ID must be a UUID");
    }
    const expectedSessionId = input.expectedSessionId?.toLowerCase();
    if (input.context !== undefined) {
      const context = input.context as unknown;
      if (!context || typeof context !== "object" || Array.isArray(context)
        || Object.entries(context).some(([key, value]) => !["projectId", "projectWorkspaceId", "issueId"].includes(key)
          || typeof value !== "string" || !uuid.test(value))) {
        throw new Error("Session context must contain only supported UUID references");
      }
    }
    const taskKey = taskKeyFor(pluginKey, input.taskKey);
    const contextJson = await contextFor(input);
    await assertCurrent(input.companyId);
    const result = await db.transaction(async tx => {
      // Both creation operations lock this parent before choosing the adapter
      // and inserting, so a delayed legacy read cannot create an old-adapter twin.
      const agent = await tx.select({ companyId: agents.companyId, adapterType: agents.adapterType }).from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .for("update").then(rows => rows[0]);
      await assertCurrent(input.companyId);
      if (!agent) throw new Error("Agent not found");
      const existing = await tx.select().from(agentTaskSessions).where(and(
        eq(agentTaskSessions.companyId, input.companyId), eq(agentTaskSessions.agentId, input.agentId),
        eq(agentTaskSessions.taskKey, taskKey), isNull(agentTaskSessions.userId),
      )).limit(2);
      await assertCurrent(input.companyId);
      if (existing.length > 1) throw new Error("Session key is ambiguous; explicit review is required");
      if (existing[0]) {
        const row = existing[0];
        if (expectedSessionId !== undefined && row.id !== expectedSessionId) {
          throw new Error("Expected session is no longer available; explicit review is required");
        }
        if (row.adapterType !== agent.adapterType || row.status !== "active" || row.closedAt !== null || !sameContext(row.contextJson, contextJson)) {
          throw new Error("Session configuration changed or is closed; explicit review is required");
        }
        return { sessionId: row.id, created: false };
      }
      if (expectedSessionId !== undefined) throw new Error("Expected session is no longer available; explicit review is required");
      const row = await tx.insert(agentTaskSessions).values({ companyId: input.companyId, agentId: input.agentId,
        adapterType: agent.adapterType, taskKey, contextJson, sessionParamsJson: null,
        sessionDisplayId: null, lastRunId: null, lastError: null }).returning().then(rows => rows[0]!);
      await assertCurrent(input.companyId);
      return { sessionId: row.id, created: true };
    });
    await assertCurrent(input.companyId);
    return result;
  }
  return { create, ensure };
}
