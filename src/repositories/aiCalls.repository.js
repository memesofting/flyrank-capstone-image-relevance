/**
 * ai_calls persistence.
 *
 * One row per provider invocation, including failures and retries. A failed call
 * that costs tokens still costs money, so "only record successes" would
 * under-report spend — which is the specific error the cost requirement exists
 * to prevent.
 */

import { query } from '../db/pool.js';

/**
 * @typedef {object} AiCallRecord
 * @property {string} [jobId]
 * @property {string} provider
 * @property {string} model
 * @property {string} operation
 * @property {number | null} [inputUnits]
 * @property {number | null} [outputUnits]
 * @property {number} estimatedCostUsd
 * @property {'SUCCESS' | 'FAILED'} status
 * @property {string} [error]
 */

const COLUMNS = `id, job_id, provider, model, operation, input_units,
  output_units, estimated_cost_usd, status, error, created_at`;

/**
 * Record one AI call.
 *
 * `estimatedCostUsd` is written even when 0, because the requirement is that
 * every AI call leaves a cost record — a free-tier call that stored no row would
 * be indistinguishable from a call that never happened.
 *
 * @param {AiCallRecord} record
 */
export async function insertAiCall({
  jobId = null,
  provider,
  model,
  operation,
  inputUnits = null,
  outputUnits = null,
  estimatedCostUsd = 0,
  status,
  error = null,
}) {
  const { rows } = await query(
    `INSERT INTO ai_calls (job_id, provider, model, operation, input_units,
       output_units, estimated_cost_usd, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      jobId,
      provider,
      model,
      operation,
      inputUnits,
      outputUnits,
      estimatedCostUsd,
      status,
      error,
    ],
  );

  return rows[0];
}

/**
 * Recent calls, newest first.
 *
 * @param {{ limit?: number, operation?: string, status?: string }} [options]
 */
export async function listAiCalls({ limit = 50, operation, status } = {}) {
  const conditions = [];
  const values = [];

  if (operation) {
    values.push(operation);
    conditions.push(`operation = $${values.length}`);
  }

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(limit);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM ai_calls
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );

  return rows;
}

/**
 * Aggregate call and spend totals, optionally over a time window.
 *
 * The budget guard and the cost report both read this. The window is expressed
 * as an interval so "today" and "this month" follow the database's clock rather
 * than the Node process's, which would otherwise disagree with it whenever the
 * two are in different zones.
 *
 * @param {{ sinceInterval?: string }} [options]
 */
export async function summariseAiCalls({ sinceInterval = null } = {}) {
  const windowClause = sinceInterval ? `WHERE created_at >= NOW() ${sinceInterval}` : '';

  const { rows } = await query(
    `SELECT
       COUNT(*)::int                                          AS total_calls,
       COUNT(*) FILTER (WHERE status = 'SUCCESS')::int        AS successful_calls,
       COUNT(*) FILTER (WHERE status = 'FAILED')::int         AS failed_calls,
       COUNT(DISTINCT model)::int                             AS distinct_models,
       COALESCE(SUM(input_units), 0)                           AS input_units,
       COALESCE(SUM(output_units), 0)                          AS output_units,
       COALESCE(SUM(estimated_cost_usd), 0)                    AS estimated_cost_usd
     FROM ai_calls
     ${windowClause}`,
  );

  return rows[0];
}

/**
 * Per-model breakdown for the cost report.
 *
 * @param {{ sinceInterval?: string }} [options]
 */
export async function summariseAiCallsByModel({ sinceInterval = null } = {}) {
  const windowClause = sinceInterval ? `WHERE created_at >= NOW() ${sinceInterval}` : '';

  const { rows } = await query(
    `SELECT
       provider,
       model,
       operation,
       COUNT(*)::int                                   AS calls,
       COUNT(*) FILTER (WHERE status = 'FAILED')::int  AS failures,
       COALESCE(SUM(input_units), 0)                    AS input_units,
       COALESCE(SUM(output_units), 0)                   AS output_units,
       COALESCE(SUM(estimated_cost_usd), 0)             AS estimated_cost_usd,
       MIN(created_at)                                 AS first_call_at,
       MAX(created_at)                                 AS last_call_at
     FROM ai_calls
     ${windowClause}
     GROUP BY provider, model, operation
     ORDER BY estimated_cost_usd DESC, calls DESC`,
  );

  return rows;
}