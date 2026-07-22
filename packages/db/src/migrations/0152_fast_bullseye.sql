CREATE TABLE "sps_node_runner_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"runner_key" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"version" text,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"profile_label" text,
	"credential_status" text DEFAULT 'unknown' NOT NULL,
	"availability_status" text DEFAULT 'unknown' NOT NULL,
	"availability_detail" text,
	"availability_source" text DEFAULT 'node_probe' NOT NULL,
	"availability_confidence" integer,
	"availability_observed_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_node_agent_runner_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"runner_profile_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD COLUMN "runner_profile_id" uuid;
--> statement-breakpoint
ALTER TABLE "sps_node_runner_profiles" ADD CONSTRAINT "sps_node_runner_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_runner_profiles" ADD CONSTRAINT "sps_node_runner_profiles_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_agent_runner_grants" ADD CONSTRAINT "sps_node_agent_runner_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_agent_runner_grants" ADD CONSTRAINT "sps_node_agent_runner_grants_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_agent_runner_grants" ADD CONSTRAINT "sps_node_agent_runner_grants_runner_profile_id_sps_node_runner_profiles_id_fk" FOREIGN KEY ("runner_profile_id") REFERENCES "public"."sps_node_runner_profiles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_agent_runner_grants" ADD CONSTRAINT "sps_node_agent_runner_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD CONSTRAINT "sps_node_commands_runner_profile_id_sps_node_runner_profiles_id_fk" FOREIGN KEY ("runner_profile_id") REFERENCES "public"."sps_node_runner_profiles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_runner_profiles_node_runner_key_unique_idx" ON "sps_node_runner_profiles" USING btree ("node_id","runner_key");
--> statement-breakpoint
CREATE INDEX "sps_node_runner_profiles_company_node_idx" ON "sps_node_runner_profiles" USING btree ("company_id","node_id");
--> statement-breakpoint
CREATE INDEX "sps_node_runner_profiles_node_availability_idx" ON "sps_node_runner_profiles" USING btree ("node_id","availability_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_agent_runner_grants_node_runner_agent_unique_idx" ON "sps_node_agent_runner_grants" USING btree ("node_id","runner_profile_id","agent_id");
--> statement-breakpoint
CREATE INDEX "sps_node_agent_runner_grants_company_node_agent_idx" ON "sps_node_agent_runner_grants" USING btree ("company_id","node_id","agent_id");
--> statement-breakpoint
CREATE INDEX "sps_node_commands_runner_created_idx" ON "sps_node_commands" USING btree ("runner_profile_id","created_at");
