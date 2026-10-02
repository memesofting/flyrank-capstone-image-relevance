/**
 * Job persistence.
 *
 * All SQL for the jobs table. The transition helpers here are written against
 * the table's own CHECK constraints, which are stricter than they first look:
 *
 *   jobs_timestamp_consistency
 *     PENDING     -> started_at IS NULL AND completed_at IS NULL
 *     PROCESSING  -> started_at IS NOT NULL AND completed_at IS NULL
 *     COMPLETED/FAILED -> started_at IS NOT NULL AND completed_at IS NOT NULL
 *
 * The consequence that is easy to get wrong: returning a job to PENDING for a
 * retry must NULL started_at. Retrying "logically" means the row is queued
 * again, not that it is half-finished. A retry UPDATE that leaves started_at
 * populated is rejected by the database, and silently "fixing" that by dropping
 * the constraint would destroy the guarantee that a job knows when it began.
 *
 *   jobs_attempts_within_max  attempts <= max_attempts
 *   jobs_reclaim_consistent   PROCESSING -> reclaimable_at IS NOT NULL
 *   jobs_attempts_timing      attempts = 0 OR last_attempt_at IS NOT NULL
 */

import { query } from '../db/pool.js';

const COLUMNS = `id, type, entity_type, entity_id, status, attempts, max_attempts,
  progress, last_error, idempotency_key, payload, reclaimable_at, last_attempt_at,
  started_at, completed_at, created_at`;

/**
 * Compose the idempotency key for a unit of AI work.
 *
 * Stable identifiers are what make a retry safe. The key deliberately excludes
 * anything volatile (timestamp, attempt number, batch id) and includes only
 * what changes the OUTPUT: entity, operation, model, model version, and prompt
 * version. Enqueueing the same work twice therefore collides at the unique index
 * instead of producing a second job.
 *
 * @param {object} parts
 * @returns {string}
 */
export function buildIdempotencyKey({ entityType, entityId, operation, model, modelVersion, promptVersion = null }) {
  const segments = [
    operation,
    entityType,
    entityId,
    model,
    modelVersion,
    promptVersion,
  ].filter((segment) => segment !== null && segment !== undefined && segment !== '');

  return segments.join(':');
}

/**
 * Insert a job, or return the existing one when the key already exists.
 *
 * ON CONFLICT ... DO UPDATE ... RETURNING rather than DO NOTHING, because
 * DO NOTHING returns zero rows on conflict and the caller would then have to
 * re-query to learn the job had already been enqueued. This way a duplicate
 * enqueue is a single round trip and is genuinely idempotent.
 *
 * @param {object} job
 * @returns {Promise<{ job: object, created: boolean }>}
 */
export async function enqueueJob({
  type,
  entityType,
  entityId,
  idempotencyKey,
  maxAttempts = 3,
  progress = 0,
  payload = {},
}) {
  const { rows } = await query(
    `INSERT INTO jobs (type, entity_type, entity_id, idempotency_key, max_attempts, progress, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING ${COLUMNS}, (xmax = 0) AS created`,
    [type, entityType, entityId, idempotencyKey, maxAttempts, progress, JSON.stringify(payload)],
  );

  const row = rows[0];
  return { job: stripInternalColumns(row), created: row.created === true };
}

/**
 * Atomically claim the oldest runnable job.
 *
 * FOR UPDATE SKIP LOCKED is what makes concurrent workers safe: each one gets a
 * different row instead of blocking on the same one, or reading the same row and
 * running the same job twice.
 *
 * Two reclaim paths are handled in one statement:
 *   - never-started jobs (reclaimable_at IS NULL)
 *   - jobs whose previous worker died mid-flight, where reclaimable_at is in the
 *     past. Without the second branch, `kill`ing a batch runner would strand
 *     every job it held.
 *
 * @param {object} [options]
 * @param {string} [options.type] restrict to one job type
 * @returns {Promise<object | null>}
 */
export async function claimNextJob({ type } = {}) {
  const { rows } = await query(
    `UPDATE jobs SET
       status        = 'PROCESSING',
       attempts      = attempts + 1,
       started_at    = COALESCE(started_at, NOW()),
       last_attempt_at = NOW(),
       reclaimable_at = NOW() + ($1 || ' seconds')::interval,
       last_error    = NULL,
       progress      = 0
      WHERE id = (
        SELECT id FROM jobs
        WHERE (
          status = 'PENDING'
          -- Recovery, not just dispatch: a worker killed mid-job leaves the row
          -- in PROCESSING, and since that row is the only record that the work
          -- was ever started, ignoring it would strand the job permanently.
          -- reclaimable_at was set when the claim began, so its expiry is the
          -- signal that the previous worker is gone.
          OR (status = 'PROCESSING' AND reclaimable_at <= NOW())
        )
          AND ($2::text IS NULL OR type = $2)
          AND (reclaimable_at IS NULL OR reclaimable_at <= NOW())
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING ${COLUMNS}`,
    [String(90), type ?? null],
  );

  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

/**
 * Mark a job COMPLETED.
 */
export async function completeJob(id, { progress = 100 } = {}) {
  const { rows } = await query(
    `UPDATE jobs SET
       status = 'COMPLETED',
       progress = $2,
       completed_at = NOW(),
       reclaimable_at = NULL
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, progress],
  );

  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

/**
 * Record a failed attempt.
 *
 * Returns the job RE-PENDING when attempts remain and the error was transient,
 * otherwise marks it terminally FAILED. The caller decides what to do next; this
 * only records the outcome.
 *
 * Note both null-outs: `started_at` because a re-queued row must satisfy
 * jobs_timestamp_consistency, and `reclaimable_at` because the row is no longer
 * in flight.
 *
 * @param {string} id
 * @param {object} options
 * @returns {Promise<object | null>}
 */
export async function failJobAttempt(id, { error, willRetry, progress = 0 }) {
  const { rows } = await query(
    `UPDATE jobs SET
       status        = CASE WHEN $2 THEN 'PENDING' ELSE 'FAILED' END,
       last_error    = $3,
       progress      = $4,
       started_at    = CASE WHEN $2 THEN NULL ELSE started_at END,
       completed_at  = CASE WHEN $2 THEN NULL ELSE NOW() END,
       reclaimable_at = NULL
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, willRetry, error, progress],
  );

  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

/**
 * Park a job for later without consuming an attempt.
 *
 * This is the quota-exhaustion path, and it is deliberately NOT failJobAttempt.
 * The free tier answers with "Please retry in 3h14m13s"; retrying in 2s cannot
 * succeed and spends the attempt budget doing nothing. So the job returns to
 * PENDING, the attempt it was claimed under is handed back, and a future
 * reclaimable_at parks it until the provider says the window has passed.
 *
 * `attempts - 1` is the important part: a job blocked by a provider quota limit
 * has not made a mistake, and letting it exhaust max_attempts would permanently
 * fail an image that was never actually analysed. GREATEST guards the floor
 * because a deferred job must not end up with a negative attempt count.
 *
 * @param {string} id
 * @param {object} options
 * @param {string} options.error reason, persisted for the operator
 * @param {number} options.delayMs how long to wait before this job is claimable
 * @returns {Promise<object | null>}
 */
export async function deferJob(id, { error, delayMs }) {
  const { rows } = await query(
    `UPDATE jobs SET
       status         = 'PENDING',
       last_error     = $2,
       progress       = 0,
       started_at     = NULL,
       completed_at   = NULL,
       attempts       = GREATEST(attempts - 1, 0),
       reclaimable_at = NOW() + ($3 || ' milliseconds')::interval
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, error, String(delayMs)],
  );

  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

/** Update progress for an in-flight job. */
export async function updateJobProgress(id, progress) {
  const { rows } = await query(
    `UPDATE jobs SET progress = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, progress],
  );

  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

export async function findJobById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

export async function findJobByIdempotencyKey(key) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM jobs WHERE idempotency_key = $1`,
    [key],
  );
  return rows[0] ? stripInternalColumns(rows[0]) : null;
}

/**
 * Counts per status, for the batch summary and the jobs endpoint.
 */
export async function countJobsByStatus({ type } = {}) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS total
     FROM jobs
     WHERE ($1::text IS NULL OR type = $1)
     GROUP BY status`,
    [type ?? null],
  );

  return rows;
}

/**
 * Jobs that are in flight and past their reclaim deadline.
 *
 * Not auto-repaired: reporting them is honest, silently resetting them is not.
 * A caller that wants recovery resets them explicitly.
 */
export async function findStalledJobs() {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM jobs
     WHERE status = 'PROCESSING' AND reclaimable_at < NOW()
     ORDER BY reclaimable_at ASC`,
  );

  return rows.map(stripInternalColumns);
}

/** `xmax` is a PostgreSQL internal, not part of the row. */
function stripInternalColumns(row) {
  const { xmax, ...rest } = row;
  return rest;
}