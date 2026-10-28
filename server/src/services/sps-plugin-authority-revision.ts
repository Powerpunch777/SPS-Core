import { eq } from "drizzle-orm";
import {
  spsPluginAuthorityCatalog,
  spsWorkspacePluginAuthority,
  type Db,
} from "../compat/paperclip/db.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Host-private equality fence, never an SDK grant or a public Plugin revision. */
export type SpsPluginAuthorityRevision = Readonly<{
  workspaceId: string;
  catalogRevision: string;
  workspaceRevision: string;
}>;

export async function readSpsPluginAuthorityRevision(
  db: Db,
  workspaceId: string,
): Promise<SpsPluginAuthorityRevision> {
  if (!UUID.test(workspaceId)) throw new Error("Plugin authority is unavailable.");
  // One statement reads both tokens from the same committed snapshot. Triggers
  // rotate them in the transaction that changes the underlying policy, even
  // if its final enabled/config value is restored before our next check.
  const [row] = await db.select({
    catalogRevision: spsPluginAuthorityCatalog.revision,
    workspaceRevision: spsWorkspacePluginAuthority.revision,
  })
    .from(spsPluginAuthorityCatalog)
    .innerJoin(spsWorkspacePluginAuthority, eq(spsWorkspacePluginAuthority.workspaceId, workspaceId))
    .where(eq(spsPluginAuthorityCatalog.id, "runtime"))
    .limit(1);
  if (!row || !UUID.test(row.catalogRevision) || !UUID.test(row.workspaceRevision)) {
    // Missing migration/backfill or lost policy state never becomes a legacy
    // fallback. These tokens can only be created by the trusted DB lifecycle.
    throw new Error("Plugin authority is unavailable.");
  }
  return Object.freeze({ workspaceId, ...row });
}

export function sameSpsPluginAuthorityRevision(
  left: SpsPluginAuthorityRevision,
  right: SpsPluginAuthorityRevision,
): boolean {
  return left.workspaceId === right.workspaceId
    && left.catalogRevision === right.catalogRevision
    && left.workspaceRevision === right.workspaceRevision;
}
