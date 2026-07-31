-- Plugin job definitions stay global, while each execution is separately
-- scoped by the existing plugin_job_runs.company_id column.
-- Existing manifests were instance jobs, so legacy rows intentionally become
-- Host-scoped when this column is introduced.
ALTER TABLE "plugin_jobs" ADD COLUMN "scope" text DEFAULT 'host' NOT NULL;
