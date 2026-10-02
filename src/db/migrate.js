/**
 * Migration runner.
 *
 * Small and explicit on purpose: a project this size does not need a
 * migration framework. SQL files in ./migrations are applied in filename
 * order, each inside its own transaction, and recorded in schema_migrations.
 *
 * Usage:
 *   node src/db/migrate.js up        apply all pending migrations
 *   node src/db/migrate.js down      roll back the most recent migration
 *   node src/db/migrate.js down 2    roll back the two most recent
 *   node src/db/migrate.js status    list applied and pending migrations
 *
 * See docs/adr/ADR-002-migration-runner.md.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { closePool, getPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

/**
 * Every migration file on disk, in the order they must be applied.
 *
 * Each migration `NNN_name.sql` may be paired with `NNN_name.down.sql`, which
 * holds the statements that undo it. There is no way to derive a rollback from
 * the forward SQL, so a migration without a `.down.sql` is simply not
 * reversible.
 */
export async function loadMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const names = entries.filter((name) => MIGRATION_PATTERN.test(name)).sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
      const downPath = join(MIGRATIONS_DIR, name.replace(/\.sql$/, '.down.sql'));
      const downSql = await readFile(downPath, 'utf8').catch(() => null);
      return {
        name,
        sql,
        downSql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function ensureMigrationsTable(client) {
  await client.query(CREATE_MIGRATIONS_TABLE);
}

async function appliedMigrations(client) {
  const { rows } = await client.query(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return new Map(rows.map((row) => [row.name, row]));
}

/**
 * Detect a migration file that was edited after it was applied. Editing an
 * applied migration silently desynchronises environments, so this is a
 * warning rather than a hard failure.
 */
function driftWarnings(files, applied) {
  const warnings = [];
  for (const file of files) {
    const record = applied.get(file.name);
    if (record && record.checksum !== file.checksum) {
      warnings.push(`${file.name} was modified after it was applied`);
    }
  }
  for (const name of applied.keys()) {
    if (!files.some((file) => file.name === name)) {
      warnings.push(`${name} is recorded as applied but no longer exists on disk`);
    }
  }
  return warnings;
}

export async function up() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const files = await loadMigrationFiles();
    const applied = await appliedMigrations(client);
    const pending = files.filter((file) => !applied.has(file.name));

    if (pending.length === 0) {
      console.log(`Migrations up to date (${files.length} applied, 0 pending).`);
      return { applied: [], skipped: files.length };
    }

    const appliedNames = [];
    for (const file of pending) {
      // Each migration is atomic: a failure leaves the schema untouched.
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum],
        );
        await client.query('COMMIT');
        appliedNames.push(file.name);
        console.log(`  applied ${file.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${error.message}`, { cause: error });
      }
    }

    console.log(`Applied ${appliedNames.length} migration(s).`);
    return { applied: appliedNames, skipped: applied.size };
  } finally {
    client.release();
  }
}

export async function down(count = 1) {
  const steps = Number.parseInt(count, 10);
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error('Rollback count must be a positive integer.');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const files = await loadMigrationFiles();
    const byName = new Map(files.map((file) => [file.name, file]));
    const { rows } = await client.query(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT $1',
      [steps],
    );

    if (rows.length === 0) {
      console.log('Nothing to roll back; no migrations are applied.');
      return { rolledBack: [] };
    }

    const rolledBack = [];
    for (const { name } of rows) {
      const file = byName.get(name);
      if (!file) {
        throw new Error(
          `Cannot roll back ${name}: the file is missing from ${MIGRATIONS_DIR}. ` +
            'Restore it or roll forward with a new migration.',
        );
      }

      if (!file.downSql) {
        throw new Error(
          `Cannot roll back ${name}: no ${name.replace(/\.sql$/, '.down.sql')} exists. ` +
            'This project does not guess rollbacks from forward SQL. Add the down ' +
            'migration, or roll forward with a new migration instead.',
        );
      }

      await client.query('BEGIN');
      try {
        await client.query(file.downSql);
        await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
        await client.query('COMMIT');
        rolledBack.push(name);
        console.log(`  rolled back ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Rollback of ${name} failed: ${error.message}. ` +
            'Fix the down migration before retrying.',
          { cause: error },
        );
      }
    }

    return { rolledBack };
  } finally {
    client.release();
  }
}

export async function status() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const files = await loadMigrationFiles();
    const applied = await appliedMigrations(client);

    console.log(`Database: ${redactedDatabaseUrl()}`);
    console.log('');
    console.log('Status       Migration');
    console.log('-----------  --------------------------------------------');

    for (const file of files) {
      const record = applied.get(file.name);
      const state = record ? 'applied' : 'pending';
      const reversible = file.downSql ? '' : '  (no down migration)';
      const at = record ? ` (${new Date(record.applied_at).toISOString()})` : '';
      console.log(`${state.padEnd(11)}  ${file.name}${at}${reversible}`);
    }

    const warnings = driftWarnings(files, applied);
    if (warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (const warning of warnings) {
        console.log(`  ! ${warning}`);
      }
    }

    const pending = files.filter((file) => !applied.has(file.name)).length;
    console.log('');
    console.log(`${applied.size} applied, ${pending} pending.`);

    return { applied: applied.size, pending, warnings };
  } finally {
    client.release();
  }
}

/** Never print the password from DATABASE_URL. */
function redactedDatabaseUrl() {
  try {
    const url = new URL(env.DATABASE_URL);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const [command = 'up', argument] = process.argv.slice(2);

  try {
    if (command === 'up') {
      await up();
    } else if (command === 'down') {
      await down(argument ?? 1);
    } else if (command === 'status') {
      await status();
    } else {
      console.error(`Unknown command: ${command}`);
      console.error('Usage: node src/db/migrate.js [up | down [count] | status]');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await main();
}
