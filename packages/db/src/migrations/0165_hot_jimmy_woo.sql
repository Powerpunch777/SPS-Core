CREATE TABLE "sps_member_device_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"device_id" uuid,
	"device_snapshot_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sps_member_device_events_action_check" CHECK ("sps_member_device_events"."action" IN ('request', 'approved', 'revoked')),
	CONSTRAINT "sps_member_device_events_revision_check" CHECK ("sps_member_device_events"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "sps_member_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"certificate" text NOT NULL,
	"certificate_sha256" text NOT NULL,
	"spki_sha256" text NOT NULL,
	"certificate_not_before" timestamp with time zone NOT NULL,
	"certificate_not_after" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sps_member_devices_status_check" CHECK ("sps_member_devices"."status" IN ('pending', 'approved', 'revoked')),
	CONSTRAINT "sps_member_devices_revision_check" CHECK ("sps_member_devices"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "sps_member_device_events" ADD CONSTRAINT "sps_member_device_events_device_id_sps_member_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sps_member_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sps_member_device_events_host_device_snapshot_created_idx" ON "sps_member_device_events" USING btree ("host_id","device_snapshot_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_member_devices_host_owner_certificate_sha256_unique_idx" ON "sps_member_devices" USING btree ("host_id","owner_user_id","certificate_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_member_devices_host_owner_spki_sha256_unique_idx" ON "sps_member_devices" USING btree ("host_id","owner_user_id","spki_sha256");--> statement-breakpoint
CREATE INDEX "sps_member_devices_host_status_idx" ON "sps_member_devices" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "sps_member_devices_host_owner_status_idx" ON "sps_member_devices" USING btree ("host_id","owner_user_id","status");