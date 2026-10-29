CREATE TABLE "sps_node_claim_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_digest" text NOT NULL,
	"workspace_execution_epoch" text NOT NULL,
	"work_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sps_node_claim_receipts" ADD CONSTRAINT "sps_node_claim_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sps_node_claim_receipts" ADD CONSTRAINT "sps_node_claim_receipts_node_id_sps_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."sps_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sps_node_claim_receipts_company_node_request_unique_idx" ON "sps_node_claim_receipts" USING btree ("company_id","node_id","request_id");--> statement-breakpoint
CREATE INDEX "sps_node_claim_receipts_node_expiry_idx" ON "sps_node_claim_receipts" USING btree ("node_id","expires_at");