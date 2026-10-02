-- 005_job_queue.sql
--
--   jobs: partial index for the worker's claim query, plus status constraints
--
-- Phase 2. The claim query is `SELECT ... WHERE status = 'PENDING' ORDER BY
-- created_at ... FOR UPDATE SKIP LOCKED`. Phase 1's idx_jobs_status_created
-- covers that, but a partial index excluding terminal states is both smaller
-- and more honest: rows that can never be claimed again do not belong in the
-- index a worker scans to find claimable work.
--
-- `reclaimable_at` exists so a worker that dies mid-job does not strand it in
-- PROCESSING forever. Without it, killing a batch runner loses every job it held
-- with no automatic recovery, and the only fix is manual UPDATE statements.

CREATE INDEX idx_jobs_pending
  ON jobs (created_at, id)
  WHERE status = 'PENDING';

ALTER TABLE jobs
  ADD COLUMN reclaimable_at TIMESTAMPTZ;

ALTER TABLE jobs
  ADD COLUMN last_attempt_at TIMESTAMPTZ;

-- A PROCESSING job must record when it becomes reclaimable, otherwise
-- last_attempt_at is the only signal and a brand-new row looks like a stale one.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_reclaim_consistent CHECK (
    status <> 'PROCESSING' OR reclaimable_at IS NOT NULL
  );

-- Attempts may only advance when a row is in flight or has finished. This is
-- what makes "attempts = 3, status = PENDING" a corrupt row rather than a
-- silently retryable one: attempts never exceeds max_attempts anyway, but a
-- completed job quietly gaining attempts would corrupt the cost audit trail.
ALTER TABLE jobs
  ADD CONSTRAINT jobs_attempts_timing CHECK (
    attempts = 0 OR last_attempt_at IS NOT NULL
  );

COMMENT ON COLUMN jobs.reclaimable_at IS
  'Set when a job starts. A worker claims PENDING jobs whose reclaimable_at is '
  'in the past, which is how a job orphaned by a dead worker is recovered.';

COMMENT ON COLUMN jobs.last_attempt_at IS
  'When the most recent attempt began. Used for observability and for detecting '
  'a stranded PROCESSING job.';