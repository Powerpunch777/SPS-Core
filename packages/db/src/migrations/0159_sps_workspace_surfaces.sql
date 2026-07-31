CREATE TABLE "sps_workspace_shell_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_plugin_id" uuid,
	"provider_plugin_key" text,
	"shell_id" text,
	"selected_by_user_id" text,
	"fallback_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_dashboard_layout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"plugin_id" uuid NOT NULL,
	"widget_id" text NOT NULL,
	"size" text NOT NULL,
	"position" integer NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_plugin_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_plugin_id" uuid,
	"source_plugin_key" text NOT NULL,
	"external_id" text NOT NULL,
	"target_user_id" text,
	"category" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"navigation_target" text,
	"action_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opaque_reference" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_plugin_inbox_user_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_workspace_shell_settings" ADD CONSTRAINT "sps_workspace_shell_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_workspace_shell_settings" ADD CONSTRAINT "sps_workspace_shell_settings_provider_plugin_id_plugins_id_fk" FOREIGN KEY ("provider_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_dashboard_layout_items" ADD CONSTRAINT "sps_dashboard_layout_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_dashboard_layout_items" ADD CONSTRAINT "sps_dashboard_layout_items_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_plugin_inbox_items" ADD CONSTRAINT "sps_plugin_inbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_plugin_inbox_items" ADD CONSTRAINT "sps_plugin_inbox_items_source_plugin_id_plugins_id_fk" FOREIGN KEY ("source_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_plugin_inbox_user_states" ADD CONSTRAINT "sps_plugin_inbox_user_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_plugin_inbox_user_states" ADD CONSTRAINT "sps_plugin_inbox_user_states_item_id_sps_plugin_inbox_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."sps_plugin_inbox_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_workspace_shell_settings_company_uq" ON "sps_workspace_shell_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "sps_workspace_shell_settings_provider_idx" ON "sps_workspace_shell_settings" USING btree ("provider_plugin_id");
--> statement-breakpoint
CREATE INDEX "sps_dashboard_layout_company_user_idx" ON "sps_dashboard_layout_items" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_dashboard_layout_company_user_widget_uq" ON "sps_dashboard_layout_items" USING btree ("company_id","user_id","plugin_id","widget_id");
--> statement-breakpoint
CREATE INDEX "sps_plugin_inbox_company_updated_idx" ON "sps_plugin_inbox_items" USING btree ("company_id","updated_at");
--> statement-breakpoint
CREATE INDEX "sps_plugin_inbox_source_idx" ON "sps_plugin_inbox_items" USING btree ("source_plugin_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_plugin_inbox_company_source_external_uq" ON "sps_plugin_inbox_items" USING btree ("company_id","source_plugin_key","external_id");
--> statement-breakpoint
CREATE INDEX "sps_plugin_inbox_state_company_user_idx" ON "sps_plugin_inbox_user_states" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_plugin_inbox_state_item_user_uq" ON "sps_plugin_inbox_user_states" USING btree ("item_id","user_id");
