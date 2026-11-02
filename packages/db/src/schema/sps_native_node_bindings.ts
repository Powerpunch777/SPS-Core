import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { spsMemberDevices } from "./sps_member_devices.js";
import { spsNodes } from "./sps_nodes.js";

/**
 * Immutable proof that one existing SPS Node identity was registered by one
 * approved Native Member device for one Workspace and Host. The legacy Node
 * row remains the execution identity; this row adds Native transport authority.
 */
export const spsNativeNodeBindings = pgTable(
  "sps_native_node_bindings",
  {
    nodeId: uuid("node_id").primaryKey().references(() => spsNodes.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Deleting a device must not silently free a still-approved Node identity
    // for rebinding. Restore scrubs bindings explicitly before device trust.
    deviceId: uuid("device_id").notNull().references(() => spsMemberDevices.id),
    hostId: uuid("host_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceNodeIdx: index("sps_native_node_bindings_workspace_node_idx").on(table.companyId, table.nodeId),
    hostDeviceIdx: index("sps_native_node_bindings_host_device_idx").on(table.hostId, table.deviceId),
  }),
);
