import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles } from "@paperclipai/db";

type FirstAdminTransaction = Pick<Db, "execute" | "select" | "insert" | "update" | "delete">;

const LOCAL_BOARD_USER_ID = "local-board";

export type FirstAdminClaimResult<T = unknown> =
  | {
      status: "claimed";
      userId: string;
      value: T | null;
    }
  | {
      status: "already_claimed";
      existingUserId: string | null;
      value: null;
    };

export async function claimFirstInstanceAdmin<T = unknown>(
  db: Db,
  input: {
    userId: string;
    onClaim?: (tx: FirstAdminTransaction) => Promise<T>;
  },
): Promise<FirstAdminClaimResult<T>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);

    const existingAdmin = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows[0] ?? null);

    if (existingAdmin) {
      return {
        status: "already_claimed" as const,
        existingUserId: existingAdmin.userId ?? null,
        value: null,
      };
    }

    await tx.insert(instanceUserRoles).values({
      userId: input.userId,
      role: "instance_admin",
    });

    const value = input.onClaim ? await input.onClaim(tx) : null;
    return {
      status: "claimed" as const,
      userId: input.userId,
      value,
    };
  });
}

/**
 * The SPS Desktop Owner Host proves control of the local Vault with two
 * launch-scoped loopback headers, but still supplies a normal SPS Identity
 * session. That narrow bootstrap path can establish the first durable
 * instance admin, and can replace only the retired local-board placeholder.
 * It must never replace an administrator belonging to another real user.
 */
export async function claimDesktopBootstrapInstanceAdmin(
  db: Db,
  input: { userId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table ${instanceUserRoles} in share row exclusive mode`);
    const admins = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));

    if (admins.some((admin) => admin.userId === input.userId)) return true;
    const onlyRetiredLocalAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_USER_ID;
    if (admins.length > 0 && !onlyRetiredLocalAdmin) return false;

    if (onlyRetiredLocalAdmin) {
      await tx
        .delete(instanceUserRoles)
        .where(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID));
    }
    await tx.insert(instanceUserRoles).values({
      userId: input.userId,
      role: "instance_admin",
    });
    return true;
  });
}
