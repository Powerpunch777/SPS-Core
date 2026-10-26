CREATE TABLE "sps_native_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"server_spki_sha256" text NOT NULL,
	"issuer_spki_sha256" text NOT NULL,
	"user_id" text NOT NULL,
	"device_key_id" uuid NOT NULL,
	"request_sha256" text NOT NULL,
	"status" text DEFAULT 'signing' NOT NULL,
	"certificate" text,
	"certificate_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "sps_native_enrollments_status_check" CHECK ("sps_native_enrollments"."status" IN ('signing', 'issued', 'failed')),
	CONSTRAINT "sps_native_enrollments_server_spki_sha256_check" CHECK (length("sps_native_enrollments"."server_spki_sha256") = 64 AND "sps_native_enrollments"."server_spki_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_native_enrollments_issuer_spki_sha256_check" CHECK (length("sps_native_enrollments"."issuer_spki_sha256") = 64 AND "sps_native_enrollments"."issuer_spki_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_native_enrollments_user_id_check" CHECK (length("sps_native_enrollments"."user_id") BETWEEN 1 AND 200),
	CONSTRAINT "sps_native_enrollments_request_sha256_check" CHECK (length("sps_native_enrollments"."request_sha256") = 64 AND "sps_native_enrollments"."request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_native_enrollments_certificate_check" CHECK ("sps_native_enrollments"."certificate" IS NULL OR (length("sps_native_enrollments"."certificate") BETWEEN 2 AND 5462 AND "sps_native_enrollments"."certificate" ~ '^([A-Za-z0-9_-]{4})*([A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$')),
	CONSTRAINT "sps_native_enrollments_certificate_sha256_check" CHECK ("sps_native_enrollments"."certificate_sha256" IS NULL OR (length("sps_native_enrollments"."certificate_sha256") = 64 AND "sps_native_enrollments"."certificate_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "sps_native_enrollments_expiry_check" CHECK ("sps_native_enrollments"."expires_at" > "sps_native_enrollments"."created_at"),
	CONSTRAINT "sps_native_enrollments_issued_check" CHECK ("sps_native_enrollments"."status" <> 'issued' OR ("sps_native_enrollments"."certificate" IS NOT NULL AND "sps_native_enrollments"."certificate_sha256" IS NOT NULL AND "sps_native_enrollments"."issued_at" IS NOT NULL AND "sps_native_enrollments"."issued_at" >= "sps_native_enrollments"."created_at" AND "sps_native_enrollments"."issued_at" < "sps_native_enrollments"."expires_at")),
	CONSTRAINT "sps_native_enrollments_unissued_check" CHECK ("sps_native_enrollments"."status" = 'issued' OR ("sps_native_enrollments"."certificate" IS NULL AND "sps_native_enrollments"."certificate_sha256" IS NULL AND "sps_native_enrollments"."issued_at" IS NULL)),
	CONSTRAINT "sps_native_enrollments_failed_check" CHECK ("sps_native_enrollments"."status" <> 'failed' OR "sps_native_enrollments"."failed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "sps_native_enrollments" ADD CONSTRAINT "sps_native_enrollments_pairing_id_sps_native_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."sps_native_pairings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_native_enrollments_pairing_id_unique_idx" ON "sps_native_enrollments" USING btree ("pairing_id");