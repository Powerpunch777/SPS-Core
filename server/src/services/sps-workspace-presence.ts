import { eq } from "drizzle-orm";
import { z } from "zod/v3";
import type { Db } from "../compat/paperclip/db.js";
import { companies } from "../compat/paperclip/db.js";

const workspaceIdSchema = z.string().uuid().transform(value => value.toLowerCase());
type WorkspacePresenceDb = Pick<Db, "select">;

/** Reads whether a Workspace currently exists; database failures are not absence. */
export async function readSpsWorkspacePresence(
  db: WorkspacePresenceDb,
  workspaceId: string,
): Promise<boolean> {
  const id = workspaceIdSchema.parse(workspaceId);
  const [workspace] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  return Boolean(workspace);
}
