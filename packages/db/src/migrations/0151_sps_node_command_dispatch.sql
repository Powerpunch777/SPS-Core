CREATE TABLE "sps_node_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "node_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "heartbeat_run_id" uuid,
  "project_id" uuid,
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
CREATE TABLE "sps_node_command_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "command_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "stream" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_command_events" ADD CONSTRAINT "sps_node_command_events_command_id_sps_node_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."sps_node_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_node_commands_node_status_created_idx" ON "sps_node_commands" USING btree ("node_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sps_node_commands_company_agent_created_idx" ON "sps_node_commands" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "sps_node_commands_heartbeat_run_idx" ON "sps_node_commands" USING btree ("heartbeat_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_command_events_command_sequence_unique_idx" ON "sps_node_command_events" USING btree ("command_id","sequence");--> statement-breakpoint
CREATE INDEX "sps_node_command_events_command_created_idx" ON "sps_node_command_events" USING btree ("command_id","created_at");
