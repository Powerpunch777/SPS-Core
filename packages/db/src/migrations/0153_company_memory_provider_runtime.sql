CREATE TABLE "company_memory_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "provider_plugin_id" uuid,
  "provider_key" text,
  "status" text DEFAULT 'enabled' NOT NULL,
  "configured_by_user_id" text,
  "last_delivery_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_memory_lifecycle_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "provider_plugin_id" uuid NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "error" text,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_memory_settings" ADD CONSTRAINT "company_memory_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_memory_settings" ADD CONSTRAINT "company_memory_settings_provider_plugin_id_plugins_id_fk" FOREIGN KEY ("provider_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_memory_lifecycle_deliveries" ADD CONSTRAINT "company_memory_lifecycle_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_memory_lifecycle_deliveries" ADD CONSTRAINT "company_memory_lifecycle_deliveries_provider_plugin_id_plugins_id_fk" FOREIGN KEY ("provider_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_settings_company_unique_idx" ON "company_memory_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "company_memory_settings_provider_idx" ON "company_memory_settings" USING btree ("provider_plugin_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_memory_lifecycle_provider_event_unique_idx" ON "company_memory_lifecycle_deliveries" USING btree ("provider_plugin_id","event_id");
--> statement-breakpoint
CREATE INDEX "company_memory_lifecycle_company_created_idx" ON "company_memory_lifecycle_deliveries" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE TABLE "plugin_tool_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "plugin_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "granted_by_user_id" text NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_tool_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "plugin_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "run_id" uuid,
  "project_id" uuid,
  "tool_name" text NOT NULL,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_tool_grants" ADD CONSTRAINT "plugin_tool_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_grants" ADD CONSTRAINT "plugin_tool_grants_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_grants" ADD CONSTRAINT "plugin_tool_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_tool_grants_plugin_agent_unique_idx" ON "plugin_tool_grants" USING btree ("plugin_id","agent_id");
--> statement-breakpoint
CREATE INDEX "plugin_tool_grants_company_agent_idx" ON "plugin_tool_grants" USING btree ("company_id","agent_id");
--> statement-breakpoint
CREATE INDEX "plugin_tool_audit_company_created_idx" ON "plugin_tool_audit_events" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "plugin_tool_audit_plugin_created_idx" ON "plugin_tool_audit_events" USING btree ("plugin_id","created_at");
--> statement-breakpoint
CREATE INDEX "plugin_tool_audit_agent_created_idx" ON "plugin_tool_audit_events" USING btree ("agent_id","created_at");
--> statement-breakpoint
ALTER TABLE "company_memory_settings" ADD CONSTRAINT "company_memory_settings_status_check" CHECK ("status" IN ('enabled', 'disabled'));
--> statement-breakpoint
ALTER TABLE "company_memory_lifecycle_deliveries" ADD CONSTRAINT "company_memory_lifecycle_deliveries_status_check" CHECK ("status" IN ('pending', 'delivered', 'failed', 'skipped'));
--> statement-breakpoint
ALTER TABLE "plugin_tool_audit_events" ADD CONSTRAINT "plugin_tool_audit_events_status_check" CHECK ("status" IN ('succeeded', 'failed', 'denied'));
