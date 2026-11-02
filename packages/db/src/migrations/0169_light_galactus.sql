CREATE TABLE "sps_native_node_bindings" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_native_node_bindings" ADD CONSTRAINT "sps_native_node_bindings_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_native_node_bindings" ADD CONSTRAINT "sps_native_node_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_native_node_bindings" ADD CONSTRAINT "sps_native_node_bindings_device_id_sps_member_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sps_member_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_native_node_bindings_workspace_node_idx" ON "sps_native_node_bindings" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE INDEX "sps_native_node_bindings_host_device_idx" ON "sps_native_node_bindings" USING btree ("host_id","device_id");