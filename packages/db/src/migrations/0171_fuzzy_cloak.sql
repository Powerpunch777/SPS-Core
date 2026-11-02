CREATE TABLE "sps_workspace_execution_control" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"epoch" text DEFAULT '0' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "workspace_execution_epoch" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "workspace_execution_epoch" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_job_runs" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sps_model_runs" ADD COLUMN "workspace_execution_epoch" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sps_node_commands" ADD COLUMN "workspace_execution_epoch" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD COLUMN "workspace_execution_epoch" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sps_workspace_execution_control" ADD CONSTRAINT "sps_workspace_execution_control_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;