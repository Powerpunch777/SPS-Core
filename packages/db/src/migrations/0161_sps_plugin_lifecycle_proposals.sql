CREATE TABLE "plugin_lifecycle_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "operation" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "target_json" jsonb NOT NULL,
  "rationale" text NOT NULL,
  "authoring_session_id" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "risk_summary" jsonb NOT NULL,
  "created_by_plugin_id" uuid REFERENCES "plugins"("id") ON DELETE set null,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
  "decision_by_user_id" uuid REFERENCES "auth_users"("id") ON DELETE set null,
  "decision_reason" text,
  "executed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plugin_lifecycle_proposals_company_created_idx" ON "plugin_lifecycle_proposals" USING btree ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "plugin_lifecycle_proposals_status_idx" ON "plugin_lifecycle_proposals" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "plugin_lifecycle_proposal_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proposal_id" uuid NOT NULL REFERENCES "plugin_lifecycle_proposals"("id") ON DELETE cascade,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "event_type" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plugin_lifecycle_proposal_events_proposal_created_idx" ON "plugin_lifecycle_proposal_events" USING btree ("proposal_id", "created_at");
--> statement-breakpoint
CREATE INDEX "plugin_lifecycle_proposal_events_company_created_idx" ON "plugin_lifecycle_proposal_events" USING btree ("company_id", "created_at");
