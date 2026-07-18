CREATE TABLE "project_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"access_role" text DEFAULT 'collaborator' NOT NULL,
	"granted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "access_mode" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_grants_project_idx" ON "project_access_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_access_grants_company_principal_idx" ON "project_access_grants" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_access_grants_project_principal_uq" ON "project_access_grants" USING btree ("project_id","principal_type","principal_id");