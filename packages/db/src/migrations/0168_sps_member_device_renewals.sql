CREATE TABLE "sps_member_device_renewal_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"predecessor_certificate_sha256" text NOT NULL,
	"certificate" text NOT NULL,
	"certificate_sha256" text NOT NULL,
	"spki_sha256" text NOT NULL,
	"issuer_spki_sha256" text NOT NULL,
	"request_sha256" text NOT NULL,
	"device_key_id" uuid NOT NULL,
	"certificate_not_before" timestamp with time zone NOT NULL,
	"certificate_not_after" timestamp with time zone NOT NULL,
	"actor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sps_member_device_renewal_certificates_predecessor_sha256_check" CHECK (length("predecessor_certificate_sha256") = 64 AND "predecessor_certificate_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_member_device_renewal_certificates_certificate_check" CHECK (length("certificate") BETWEEN 2 AND 5462 AND "certificate" ~ '^([A-Za-z0-9_-]{4})*([A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$'),
	CONSTRAINT "sps_member_device_renewal_certificates_certificate_sha256_check" CHECK (length("certificate_sha256") = 64 AND "certificate_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_member_device_renewal_certificates_spki_sha256_check" CHECK (length("spki_sha256") = 64 AND "spki_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_member_device_renewal_certificates_issuer_spki_sha256_check" CHECK (length("issuer_spki_sha256") = 64 AND "issuer_spki_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_member_device_renewal_certificates_request_sha256_check" CHECK (length("request_sha256") = 64 AND "request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sps_member_device_renewal_certificates_actor_user_id_check" CHECK (length("actor_user_id") BETWEEN 1 AND 200),
	CONSTRAINT "sps_member_device_renewal_certificates_expiry_check" CHECK ("certificate_not_after" > "certificate_not_before")
);
--> statement-breakpoint
ALTER TABLE "sps_member_device_renewal_certificates" ADD CONSTRAINT "sps_member_device_renewal_certificates_device_id_sps_member_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."sps_member_devices"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "sps_member_device_renewal_certificates_device_predecessor_sha256_unique_idx" ON "sps_member_device_renewal_certificates" USING btree ("device_id","predecessor_certificate_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "sps_member_device_renewal_certificates_certificate_sha256_unique_idx" ON "sps_member_device_renewal_certificates" USING btree ("certificate_sha256");--> statement-breakpoint
CREATE INDEX "sps_member_device_renewal_certificates_device_created_idx" ON "sps_member_device_renewal_certificates" USING btree ("device_id","created_at");
