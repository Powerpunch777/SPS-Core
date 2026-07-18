import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Explicit access grants are only evaluated when a Project uses restricted
 * access. project_memberships remains a personal join/star preference table.
 */
export const projectAccessGrants = pgTable(
  "project_access_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    accessRole: text("access_role").notNull().default("collaborator"),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("project_access_grants_project_idx").on(table.projectId),
    companyPrincipalIdx: index("project_access_grants_company_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    projectPrincipalUq: uniqueIndex("project_access_grants_project_principal_uq").on(
      table.projectId,
      table.principalType,
      table.principalId,
    ),
  }),
);
