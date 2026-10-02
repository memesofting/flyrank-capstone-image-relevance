DROP INDEX IF EXISTS jobs_payload_gin;

ALTER TABLE jobs
  DROP COLUMN IF EXISTS payload;
