import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Platform execution admission, independent of workflow and budget policies. */
export const spsWorkspaceExecutionControl = pgTable("sps_workspace_execution_control", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  state: text("state").$type<"running" | "paused" | "stopped">().notNull().default("running"),
  // Decimal text avoids JS number truncation and allows an unbounded stop generation.
  epoch: text("epoch").notNull().default("0"),
  revision: integer("revision").notNull().default(0),
  updatedByUserId: text("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
