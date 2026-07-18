import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  projectAccessGrants,
  projects,
} from "@paperclipai/db";
import type { ProjectAccessGrant, ProjectAccessMode, ProjectAccessRole } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";

export type ProjectAccessGrantInput = {
  principalType: "user" | "agent";
  principalId: string;
  accessRole: ProjectAccessRole;
};

const ACTIVE_AGENT_STATUSES_BLOCKED = new Set(["pending_approval", "terminated"]);

function normalizedGrantKey(grant: ProjectAccessGrantInput) {
  return `${grant.principalType}:${grant.principalId}`;
}

function asAccessRole(value: string): ProjectAccessRole {
  if (value === "viewer" || value === "manager") return value;
  return "collaborator";
}

export function projectAccessService(db: Db) {
  async function list(companyId: string, projectId: string): Promise<ProjectAccessGrant[]> {
    const rows = await db
      .select()
      .from(projectAccessGrants)
      .where(and(
        eq(projectAccessGrants.companyId, companyId),
        eq(projectAccessGrants.projectId, projectId),
      ));

    const userIds = rows
      .filter((row) => row.principalType === "user")
      .map((row) => row.principalId);
    const agentIds = rows
      .filter((row) => row.principalType === "agent")
      .map((row) => row.principalId);
    const [users, agentRows] = await Promise.all([
      userIds.length
        ? db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
          .from(authUsers)
          .where(inArray(authUsers.id, userIds))
        : Promise.resolve([]),
      agentIds.length
        ? db.select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
        : Promise.resolve([]),
    ]);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

    return rows
      .map((row) => {
        const principal = row.principalType === "user"
          ? (() => {
              const user = usersById.get(row.principalId);
              return user ? { name: user.name ?? null, email: user.email ?? null } : null;
            })()
          : (() => {
              const agent = agentsById.get(row.principalId);
              return agent ? { name: agent.name ?? null, email: null } : null;
            })();
        return {
          id: row.id,
          companyId: row.companyId,
          projectId: row.projectId,
          principalType: row.principalType === "agent" ? "agent" : "user",
          principalId: row.principalId,
          accessRole: asAccessRole(row.accessRole),
          grantedByUserId: row.grantedByUserId ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          principal,
        } satisfies ProjectAccessGrant;
      })
      .sort((left, right) => {
        const principalType = left.principalType.localeCompare(right.principalType);
        if (principalType !== 0) return principalType;
        const name = (left.principal?.name ?? left.principalId).localeCompare(right.principal?.name ?? right.principalId);
        return name || left.principalId.localeCompare(right.principalId);
      });
  }

  async function assertGrantPrincipalsAreActive(companyId: string, grants: ProjectAccessGrantInput[]) {
    const userIds = grants.filter((grant) => grant.principalType === "user").map((grant) => grant.principalId);
    const agentIds = grants.filter((grant) => grant.principalType === "agent").map((grant) => grant.principalId);
    const [activeUsers, activeAgents] = await Promise.all([
      userIds.length
        ? db.select({ principalId: companyMemberships.principalId })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, userIds),
          ))
        : Promise.resolve([]),
      agentIds.length
        ? db.select({ id: agents.id, status: agents.status })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
        : Promise.resolve([]),
    ]);
    const validUserIds = new Set(activeUsers.map((row) => row.principalId));
    const validAgentIds = new Set(
      activeAgents
        .filter((row) => !ACTIVE_AGENT_STATUSES_BLOCKED.has(row.status))
        .map((row) => row.id),
    );
    const invalid = grants.filter((grant) =>
      grant.principalType === "user"
        ? !validUserIds.has(grant.principalId)
        : !validAgentIds.has(grant.principalId),
    );
    if (invalid.length > 0) {
      throw unprocessable("Project access grants require active Company members or active Agents.", {
        invalid: invalid.map((grant) => ({ principalType: grant.principalType, principalId: grant.principalId })),
      });
    }
  }

  return {
    list,

    async replace(input: {
      companyId: string;
      projectId: string;
      accessMode: ProjectAccessMode;
      grants: ProjectAccessGrantInput[];
      grantedByUserId: string | null;
    }) {
      const deduplicated = new Map<string, ProjectAccessGrantInput>();
      for (const grant of input.grants) {
        const key = normalizedGrantKey(grant);
        if (deduplicated.has(key)) {
          throw conflict("Project access policy contains the same principal more than once.", { principal: key });
        }
        deduplicated.set(key, grant);
      }
      const grants = Array.from(deduplicated.values());
      await assertGrantPrincipalsAreActive(input.companyId, grants);

      await db.transaction(async (tx) => {
        const project = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!project) throw unprocessable("Project does not belong to this Company.");

        const now = new Date();
        await tx
          .update(projects)
          .set({ accessMode: input.accessMode, updatedAt: now })
          .where(eq(projects.id, input.projectId));
        await tx
          .delete(projectAccessGrants)
          .where(and(
            eq(projectAccessGrants.companyId, input.companyId),
            eq(projectAccessGrants.projectId, input.projectId),
          ));
        if (grants.length > 0) {
          await tx.insert(projectAccessGrants).values(grants.map((grant) => ({
            companyId: input.companyId,
            projectId: input.projectId,
            principalType: grant.principalType,
            principalId: grant.principalId,
            accessRole: grant.accessRole,
            grantedByUserId: input.grantedByUserId,
            createdAt: now,
            updatedAt: now,
          })));
        }
      });

      return {
        accessMode: input.accessMode,
        grants: await list(input.companyId, input.projectId),
      };
    },
  };
}
