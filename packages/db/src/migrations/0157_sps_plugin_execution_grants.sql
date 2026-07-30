CREATE TABLE "sps_plugin_execution_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"node_id" uuid NOT NULL,
	"runner_profile_id" uuid NOT NULL,
	"workspace_source_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_plugin_node_run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stream" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_plugin_node_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"execution_grant_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"runner_profile_id" uuid NOT NULL,
	"workspace_source_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"command" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cwd_hint" text,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stdin" text,
	"timeout_ms" integer,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"timed_out" integer DEFAULT 0 NOT NULL,
	"error" text,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_plugin_execution_grants" ADD CONSTRAINT "sps_plugin_execution_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_execution_grants" ADD CONSTRAINT "sps_plugin_execution_grants_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_execution_grants" ADD CONSTRAINT "sps_plugin_execution_grants_runner_profile_id_sps_node_runner_profiles_id_fk" FOREIGN KEY ("runner_profile_id") REFERENCES "public"."sps_node_runner_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_execution_grants" ADD CONSTRAINT "sps_plugin_execution_grants_workspace_source_id_sps_workspace_sources_id_fk" FOREIGN KEY ("workspace_source_id") REFERENCES "public"."sps_workspace_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_run_events" ADD CONSTRAINT "sps_plugin_node_run_events_run_id_sps_plugin_node_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sps_plugin_node_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD CONSTRAINT "sps_plugin_node_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD CONSTRAINT "sps_plugin_node_runs_execution_grant_id_sps_plugin_execution_grants_id_fk" FOREIGN KEY ("execution_grant_id") REFERENCES "public"."sps_plugin_execution_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD CONSTRAINT "sps_plugin_node_runs_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD CONSTRAINT "sps_plugin_node_runs_runner_profile_id_sps_node_runner_profiles_id_fk" FOREIGN KEY ("runner_profile_id") REFERENCES "public"."sps_node_runner_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD CONSTRAINT "sps_plugin_node_runs_workspace_source_id_sps_workspace_sources_id_fk" FOREIGN KEY ("workspace_source_id") REFERENCES "public"."sps_workspace_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_plugin_execution_grants_plugin_subject_target_unique_idx" ON "sps_plugin_execution_grants" USING btree ("company_id","plugin_key","subject_key","node_id","runner_profile_id","workspace_source_id");--> statement-breakpoint
CREATE INDEX "sps_plugin_execution_grants_company_plugin_subject_idx" ON "sps_plugin_execution_grants" USING btree ("company_id","plugin_key","subject_key");--> statement-breakpoint
CREATE INDEX "sps_plugin_execution_grants_node_status_idx" ON "sps_plugin_execution_grants" USING btree ("node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_plugin_node_run_events_run_sequence_unique_idx" ON "sps_plugin_node_run_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "sps_plugin_node_run_events_run_created_idx" ON "sps_plugin_node_run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "sps_plugin_node_runs_node_status_created_idx" ON "sps_plugin_node_runs" USING btree ("node_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sps_plugin_node_runs_company_plugin_subject_created_idx" ON "sps_plugin_node_runs" USING btree ("company_id","plugin_key","subject_key","created_at");--> statement-breakpoint
CREATE INDEX "sps_plugin_node_runs_execution_grant_idx" ON "sps_plugin_node_runs" USING btree ("execution_grant_id");
