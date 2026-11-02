import { and, eq } from "drizzle-orm";
import { spsMemberDevices, spsNativeNodeBindings, spsNodes, type Db } from "../compat/paperclip/db.js";

export type SpsNativeNodeBinding = typeof spsNativeNodeBindings.$inferSelect;

/** Host-internal persistence for the immutable Native device ↔ Node association. */
export function spsNativeNodeBindingService(db: Db) {
  return {
    async get(nodeId: string): Promise<SpsNativeNodeBinding | null> {
      return await db.select().from(spsNativeNodeBindings).where(eq(spsNativeNodeBindings.nodeId, nodeId))
        .then(rows => rows[0] ?? null);
    },

    async bind(input: {
      nodeId: string;
      companyId: string;
      deviceId: string;
      hostId: string;
      ownerUserId: string;
    }): Promise<SpsNativeNodeBinding> {
      const [node] = await db.select().from(spsNodes).where(and(
        eq(spsNodes.id, input.nodeId), eq(spsNodes.companyId, input.companyId), eq(spsNodes.ownerUserId, input.ownerUserId),
      ));
      const [device] = await db.select().from(spsMemberDevices).where(and(
        eq(spsMemberDevices.id, input.deviceId), eq(spsMemberDevices.hostId, input.hostId),
        eq(spsMemberDevices.ownerUserId, input.ownerUserId), eq(spsMemberDevices.status, "approved"),
      ));
      if (!node || node.status === "revoked" || !device) {
        throw new Error("Native Node binding authority is unavailable");
      }
      const existing = await this.get(input.nodeId);
      if (existing) {
        if (existing.companyId === input.companyId && existing.deviceId === input.deviceId
          && existing.hostId === input.hostId && existing.ownerUserId === input.ownerUserId) return existing;
        throw new Error("SPS Node is already bound to another Native device");
      }
      const [created] = await db.insert(spsNativeNodeBindings).values(input).onConflictDoNothing().returning();
      if (created) return created;
      const raced = await this.get(input.nodeId);
      if (raced && raced.companyId === input.companyId && raced.deviceId === input.deviceId
        && raced.hostId === input.hostId && raced.ownerUserId === input.ownerUserId) return raced;
      throw new Error("SPS Node is already bound to another Native device");
    },
  };
}
