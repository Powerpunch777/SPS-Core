CREATE TABLE "sps_node_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"nonce_hash" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_nodes" ADD COLUMN "key_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sps_node_heartbeats" ADD CONSTRAINT "sps_node_heartbeats_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_heartbeats_nonce_unique_idx" ON "sps_node_heartbeats" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "sps_node_heartbeats_node_expiry_idx" ON "sps_node_heartbeats" USING btree ("node_id","expires_at");