-- 005_job_queue.sql (down)
-- Reverts the job queue additions.

ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_attempts_timing,
  DROP CONSTRAINT IF EXISTS jobs_reclaim_consistent;

DROP INDEX IF EXISTS idx_jobs_pending;

ALTER TABLE jobs
  DROP COLUMN IF EXISTS last_attempt_at,
  DROP COLUMN IF EXISTS reclaimable_at;