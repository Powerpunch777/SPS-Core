ALTER TABLE "agent_task_sessions" ADD COLUMN "user_id" text;
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "closed_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE;
--> statement-breakpoint
DROP INDEX "agent_task_sessions_company_agent_adapter_task_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_sessions_company_agent_adapter_task_uniq" ON "agent_task_sessions" USING btree ("company_id", "agent_id", "adapter_type", "task_key") WHERE "user_id" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_sessions_company_user_agent_adapter_task_uniq" ON "agent_task_sessions" USING btree ("company_id", "user_id", "agent_id", "adapter_type", "task_key") WHERE "user_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_sessions_company_user_active_assistant_uniq" ON "agent_task_sessions" USING btree ("company_id", "user_id", "agent_id") WHERE "user_id" is not null and "status" = 'active' and "task_key" like 'sps-marketplace-assistant:%';
--> statement-breakpoint
CREATE TABLE "sps_marketplace_assistant_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "sps_marketplace_assistant_messages_session_id_agent_task_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_task_sessions"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_marketplace_assistant_messages_session_idempotency_uniq" ON "sps_marketplace_assistant_messages" USING btree ("session_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "sps_marketplace_assistant_messages_session_created_idx" ON "sps_marketplace_assistant_messages" USING btree ("session_id", "created_at", "id");
