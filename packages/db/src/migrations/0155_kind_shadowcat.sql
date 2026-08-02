CREATE TABLE "sps_host_project_share_node_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"credential_algorithm" text DEFAULT 'rsa-oaep-sha256' NOT NULL,
	"credential_envelope" text NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_host_project_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"host_node_id" uuid,
	"share_path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD COLUMN "workspace_access" jsonb;--> statement-breakpoint
ALTER TABLE "sps_host_project_share_node_grants" ADD CONSTRAINT "sps_host_project_share_node_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_host_project_share_node_grants" ADD CONSTRAINT "sps_host_project_share_node_grants_share_id_sps_host_project_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."sps_host_project_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_host_project_share_node_grants" ADD CONSTRAINT "sps_host_project_share_node_grants_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_host_project_shares" ADD CONSTRAINT "sps_host_project_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_host_project_shares" ADD CONSTRAINT "sps_host_project_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_host_project_shares" ADD CONSTRAINT "sps_host_project_shares_host_node_id_sps_nodes_id_fk" FOREIGN KEY ("host_node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_host_project_share_node_grants_share_node_unique_idx" ON "sps_host_project_share_node_grants" USING btree ("share_id","node_id");--> statement-breakpoint
CREATE INDEX "sps_host_project_share_node_grants_company_node_idx" ON "sps_host_project_share_node_grants" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_host_project_shares_company_project_unique_idx" ON "sps_host_project_shares" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "sps_host_project_shares_host_node_idx" ON "sps_host_project_shares" USING btree ("host_node_id");
