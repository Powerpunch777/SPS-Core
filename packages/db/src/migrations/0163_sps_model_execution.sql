CREATE TABLE "sps_model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"protocol" text DEFAULT 'responses_text_v1' NOT NULL,
	"endpoint" text NOT NULL,
	"model" text NOT NULL,
	"secret_id" uuid,
	"version_selector" text DEFAULT 'latest' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allow_loopback_http" boolean DEFAULT false NOT NULL,
	"timeout_ms" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"max_request_bytes" integer NOT NULL,
	"max_response_bytes" integer NOT NULL,
	"max_concurrent_requests" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_model_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"binding_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sps_model_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"grant_id" uuid,
	"grant_revision" integer NOT NULL,
	"request_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"external_effects" text DEFAULT 'not_dispatched' NOT NULL,
	"error_code" text,
	"cancellation_requested_at" timestamp with time zone,
	"result_json" jsonb,
	"usage_json" jsonb,
	"resource_pending" boolean DEFAULT true NOT NULL,
	"lease_owner_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_model_connections" ADD CONSTRAINT "sps_model_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_connections" ADD CONSTRAINT "sps_model_connections_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_grants" ADD CONSTRAINT "sps_model_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_grants" ADD CONSTRAINT "sps_model_grants_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_grants" ADD CONSTRAINT "sps_model_grants_connection_id_sps_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sps_model_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_grants" ADD CONSTRAINT "sps_model_grants_binding_id_company_secret_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."company_secret_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_runs" ADD CONSTRAINT "sps_model_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_runs" ADD CONSTRAINT "sps_model_runs_connection_id_sps_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sps_model_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_model_runs" ADD CONSTRAINT "sps_model_runs_grant_id_sps_model_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."sps_model_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_model_connections_company_created_idx" ON "sps_model_connections" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_model_grants_company_connection_plugin_uq" ON "sps_model_grants" USING btree ("company_id","connection_id","plugin_id");--> statement-breakpoint
CREATE INDEX "sps_model_grants_company_plugin_status_idx" ON "sps_model_grants" USING btree ("company_id","plugin_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_model_runs_company_plugin_request_key_uq" ON "sps_model_runs" USING btree ("company_id","plugin_id","request_key");--> statement-breakpoint
CREATE INDEX "sps_model_runs_company_plugin_created_idx" ON "sps_model_runs" USING btree ("company_id","plugin_key","created_at");--> statement-breakpoint
CREATE INDEX "sps_model_runs_connection_lease_idx" ON "sps_model_runs" USING btree ("connection_id","lease_expires_at");