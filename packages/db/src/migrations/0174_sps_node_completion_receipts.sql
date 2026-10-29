ALTER TABLE "sps_node_commands" ADD COLUMN "completion_receipt_digest" text;--> statement-breakpoint
ALTER TABLE "sps_plugin_node_runs" ADD COLUMN "completion_receipt_digest" text;