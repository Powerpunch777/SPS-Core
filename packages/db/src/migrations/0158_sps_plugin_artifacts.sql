CREATE TABLE "sps_plugin_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"run_id" uuid,
	"title" text NOT NULL,
	"kind" text DEFAULT 'reference' NOT NULL,
	"reference_url" text,
	"summary" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_plugin_artifacts" ADD CONSTRAINT "sps_plugin_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_plugin_artifacts" ADD CONSTRAINT "sps_plugin_artifacts_run_id_sps_plugin_node_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sps_plugin_node_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_plugin_artifacts_company_plugin_subject_created_idx" ON "sps_plugin_artifacts" USING btree ("company_id","plugin_key","subject_key","created_at");--> statement-breakpoint
CREATE INDEX "sps_plugin_artifacts_run_idx" ON "sps_plugin_artifacts" USING btree ("run_id");
