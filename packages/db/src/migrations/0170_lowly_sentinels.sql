ALTER TABLE "sps_native_node_bindings" DROP CONSTRAINT "sps_native_node_bindings_device_id_sps_member_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "sps_native_node_bindings" ADD CONSTRAINT "sps_native_node_bindings_device_id_sps_member_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sps_member_devices"("id") ON DELETE no action ON UPDATE no action;