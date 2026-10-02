-- 003_jobs_cost_and_eval.sql
--
--   jobs       - background work queue with retries and progress
--   ai_calls   - per-call provider/model/cost audit
--   eval_cases - labeled post -> expected image pairs for evaluation
--
-- No worker, cost calculation, or evaluation logic exists in Phase 1. This
-- migration only establishes the persistent shape those features will use.

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
-- idempotency_key is the deduplication mechanism for retried work. It is
-- derived from entity + operation + model version, so a repeated request
-- cannot enqueue a second AI job (docs/API.md, "Idempotency").
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  last_error TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT jobs_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),

  -- A finished job must record when it finished; a running one must record
  -- when it started. Both stay NULL while PENDING.
  CONSTRAINT jobs_timestamp_consistency CHECK (
    (status = 'PENDING' AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'PROCESSING' AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('COMPLETED', 'FAILED') AND started_at IS NOT NULL AND completed_at IS NOT NULL)
  ),

  -- Retries stop at max_attempts; a job cannot have tried more than allowed.
  CONSTRAINT jobs_attempts_within_max CHECK (attempts <= max_attempts)
);

-- The worker's claim query: oldest first among PENDING rows.
CREATE INDEX idx_jobs_status_created ON jobs (status, created_at);

-- Per-entity job lookup, e.g. "what work exists for this image?".
CREATE INDEX idx_jobs_entity ON jobs (entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- ai_calls
-- ---------------------------------------------------------------------------
-- One row per AI invocation, including failures and retries. Free-tier calls
-- record estimated_cost_usd = 0 rather than being omitted
-- (docs/AI-PIPELINE.md, "Cost tracking").
--
-- job_id is nullable and set to NULL on job deletion so cost history survives.
CREATE TABLE ai_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs (id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_units NUMERIC,
  output_units NUMERIC,
  estimated_cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0 CHECK (estimated_cost_usd >= 0),
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_calls_status_check CHECK (status IN ('SUCCESS', 'FAILED')),
  CONSTRAINT ai_calls_error_required_on_failure CHECK (status <> 'FAILED' OR error IS NOT NULL)
);

-- Cost reports and the budget guard read totals over a time window.
CREATE INDEX idx_ai_calls_created ON ai_calls (created_at);

-- Per-job cost audit: "what did this job spend?".
CREATE INDEX idx_ai_calls_job ON ai_calls (job_id);

-- ---------------------------------------------------------------------------
-- eval_cases
-- ---------------------------------------------------------------------------
-- A labeled expectation: this post should match this image. Top-1 precision is
-- measured against these rows (docs/PROJECT-REQUIREMENTS.md).
CREATE TABLE eval_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts (id) ON DELETE RESTRICT,
  expected_image_id UUID NOT NULL REFERENCES images (id) ON DELETE RESTRICT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One expected image per post: top-1 precision needs a single answer.
  CONSTRAINT uq_eval_post UNIQUE (post_id)
);
