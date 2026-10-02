/**
 * PostgreSQL connection pool.
 *
 * Created lazily so importing this module never opens a socket by itself; the
 * first query does. That keeps CLI tools and unit tests from requiring a
 * running database.
 */

import pg from 'pg';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (pool) {
    return pool;
  }

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // An idle client erroring out must not crash the process.
  pool.on('error', (error) => {
    logger.error('Unexpected error on idle PostgreSQL client', { error: error.message });
  });

  return pool;
}

/**
 * Run a parameterized query. Callers pass values, never concatenated SQL.
 *
 * @param {string} text
 * @param {unknown[]} [values]
 * @returns {Promise<import('pg').QueryResult>}
 */
export function query(text, values = []) {
  return getPool().query(text, values);
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * thrown error. Multi-step writes use this so a partial write cannot persist.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) {
    return;
  }
  const closing = pool;
  pool = null;
  await closing.end();
}
