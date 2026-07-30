CREATE TABLE "sps_workspace_source_node_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"credential_algorithm" text DEFAULT 'rsa-oaep-sha256' NOT NULL,
	"credential_envelope" text NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_workspace_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"share_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_workspace_source_node_grants" ADD CONSTRAINT "sps_workspace_source_node_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_workspace_source_node_grants" ADD CONSTRAINT "sps_workspace_source_node_grants_source_id_sps_workspace_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sps_workspace_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_workspace_source_node_grants" ADD CONSTRAINT "sps_workspace_source_node_grants_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_workspace_sources" ADD CONSTRAINT "sps_workspace_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_workspace_source_node_grants_source_node_unique_idx" ON "sps_workspace_source_node_grants" USING btree ("source_id","node_id");--> statement-breakpoint
CREATE INDEX "sps_workspace_source_node_grants_company_node_idx" ON "sps_workspace_source_node_grants" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_workspace_sources_company_name_unique_idx" ON "sps_workspace_sources" USING btree ("company_id","display_name");--> statement-breakpoint
CREATE INDEX "sps_workspace_sources_company_status_idx" ON "sps_workspace_sources" USING btree ("company_id","status");