CREATE TABLE "sps_native_pairing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"pairing_id" uuid,
	"pairing_snapshot_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"device_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sps_native_pairing_events_action_check" CHECK ("sps_native_pairing_events"."action" IN ('created', 'secret_rejected', 'consumed', 'revoked', 'exhausted'))
);
--> statement-breakpoint
CREATE TABLE "sps_native_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"server_spki_sha256" text NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"secret_sha256" text NOT NULL,
	"target_email_sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" text,
	"consumed_device_id" uuid,
	"consumed_device_snapshot_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	CONSTRAINT "sps_native_pairings_status_check" CHECK ("sps_native_pairings"."status" IN ('pending', 'consumed', 'revoked', 'exhausted')),
	CONSTRAINT "sps_native_pairings_secret_sha256_check" CHECK (length("sps_native_pairings"."secret_sha256") = 64 AND "sps_native_pairings"."secret_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_native_pairings_target_email_sha256_check" CHECK ("sps_native_pairings"."target_email_sha256" IS NULL OR (length("sps_native_pairings"."target_email_sha256") = 64 AND "sps_native_pairings"."target_email_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "sps_native_pairings_server_spki_sha256_check" CHECK (length("sps_native_pairings"."server_spki_sha256") = 64 AND "sps_native_pairings"."server_spki_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_native_pairings_attempts_check" CHECK ("sps_native_pairings"."max_attempts" > 0 AND "sps_native_pairings"."max_attempts" <= 20 AND "sps_native_pairings"."failed_attempts" >= 0 AND "sps_native_pairings"."failed_attempts" <= "sps_native_pairings"."max_attempts"),
	CONSTRAINT "sps_native_pairings_expiry_check" CHECK ("sps_native_pairings"."expires_at" > "sps_native_pairings"."created_at"),
	CONSTRAINT "sps_native_pairings_consumed_check" CHECK ("sps_native_pairings"."status" <> 'consumed' OR ("sps_native_pairings"."consumed_at" IS NOT NULL AND "sps_native_pairings"."consumed_by_user_id" IS NOT NULL AND "sps_native_pairings"."consumed_device_snapshot_id" IS NOT NULL)),
	CONSTRAINT "sps_native_pairings_consumed_at_window_check" CHECK ("sps_native_pairings"."consumed_at" IS NULL OR ("sps_native_pairings"."consumed_at" >= "sps_native_pairings"."created_at" AND "sps_native_pairings"."consumed_at" < "sps_native_pairings"."expires_at")),
	CONSTRAINT "sps_native_pairings_revoked_check" CHECK ("sps_native_pairings"."status" <> 'revoked' OR ("sps_native_pairings"."revoked_at" IS NOT NULL AND "sps_native_pairings"."revoked_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sps_native_pairing_events" ADD CONSTRAINT "sps_native_pairing_events_pairing_id_sps_native_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."sps_native_pairings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_native_pairings" ADD CONSTRAINT "sps_native_pairings_consumed_device_id_sps_member_devices_id_fk" FOREIGN KEY ("consumed_device_id") REFERENCES "public"."sps_member_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_native_pairing_events_host_pairing_snapshot_created_idx" ON "sps_native_pairing_events" USING btree ("host_id","pairing_snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "sps_native_pairings_host_status_expires_idx" ON "sps_native_pairings" USING btree ("host_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "sps_native_pairings_host_server_spki_status_expires_idx" ON "sps_native_pairings" USING btree ("host_id","server_spki_sha256","status","expires_at");