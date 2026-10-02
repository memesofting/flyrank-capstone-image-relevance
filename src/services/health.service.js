/**
 * Health checks.
 *
 * `/health` answers "is the process up" and must not depend on anything
 * external. `/health/ready` answers "can this process serve traffic", which
 * does require the database. Splitting them keeps a database outage visible as
 * a readiness failure instead of a false liveness failure.
 */

import { DB_HEALTHCHECK_TIMEOUT_MS } from '../config/constants.js';
import { query } from '../db/pool.js';

/** Liveness. No I/O, so it cannot fail because of a dependency. */
export function liveness() {
  return {
    status: 'ok',
    service: 'flyrank-image-matcher',
  };
}

/**
 * Readiness. Probes the database with a bounded timeout so a hung connection
 * cannot hold the request open.
 *
 * @returns {Promise<{ status: 'ok', database: 'ok' } | { status: 'degraded', database: 'unavailable', reason: string }>}
 */
export async function readiness() {
  try {
    const result = await Promise.race([
      query('SELECT 1 AS ok'),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`database probe exceeded ${DB_HEALTHCHECK_TIMEOUT_MS}ms`)),
          DB_HEALTHCHECK_TIMEOUT_MS,
        ),
      ),
    ]);

    if (result.rows[0]?.ok !== 1) {
      return { status: 'degraded', database: 'unavailable', reason: 'unexpected probe result' };
    }

    return { status: 'ok', database: 'ok' };
  } catch (error) {
    return { status: 'degraded', database: 'unavailable', reason: error.message };
  }
}
