CREATE TABLE "sps_agent_node_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"assigned_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_node_agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"public_key" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_agent_node_bindings" ADD CONSTRAINT "sps_agent_node_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_agent_node_bindings" ADD CONSTRAINT "sps_agent_node_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_agent_node_bindings" ADD CONSTRAINT "sps_agent_node_bindings_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_agent_grants" ADD CONSTRAINT "sps_node_agent_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_agent_grants" ADD CONSTRAINT "sps_node_agent_grants_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_agent_grants" ADD CONSTRAINT "sps_node_agent_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_nodes" ADD CONSTRAINT "sps_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_agent_node_bindings_agent_unique_idx" ON "sps_agent_node_bindings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sps_agent_node_bindings_company_node_idx" ON "sps_agent_node_bindings" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_agent_grants_node_agent_unique_idx" ON "sps_node_agent_grants" USING btree ("node_id","agent_id");--> statement-breakpoint
CREATE INDEX "sps_node_agent_grants_company_node_idx" ON "sps_node_agent_grants" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE INDEX "sps_node_agent_grants_company_agent_idx" ON "sps_node_agent_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_nodes_company_public_key_unique_idx" ON "sps_nodes" USING btree ("company_id","public_key");--> statement-breakpoint
CREATE INDEX "sps_nodes_company_status_idx" ON "sps_nodes" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "sps_nodes_owner_status_idx" ON "sps_nodes" USING btree ("owner_user_id","status");