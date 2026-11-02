CREATE TABLE "sps_plugin_package_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"kind" text NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"remove_data" boolean DEFAULT false NOT NULL,
	"active_plugin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_plugin_package_operations_active_plugin_idx" ON "sps_plugin_package_operations" USING btree ("active_plugin_id");--> statement-breakpoint
CREATE INDEX "sps_plugin_package_operations_plugin_key_idx" ON "sps_plugin_package_operations" USING btree ("plugin_key");--> statement-breakpoint
CREATE INDEX "sps_plugin_package_operations_pending_idx" ON "sps_plugin_package_operations" USING btree ("completed_at");