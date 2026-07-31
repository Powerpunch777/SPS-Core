-- Lifecycle proposal audit is append-only. Existing databases created by
-- 0161 used a cascading foreign key, which would erase the audit trail when
-- a proposal is removed. Retain the event rows instead.
ALTER TABLE "plugin_lifecycle_proposal_events"
  DROP CONSTRAINT IF EXISTS "plugin_lifecycle_proposal_events_proposal_id_plugin_lifecycle_proposals_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_lifecycle_proposal_events"
  ADD CONSTRAINT "plugin_lifecycle_proposal_events_proposal_id_plugin_lifecycle_proposals_id_fk"
  FOREIGN KEY ("proposal_id") REFERENCES "plugin_lifecycle_proposals"("id") ON DELETE restrict ON UPDATE no action;
