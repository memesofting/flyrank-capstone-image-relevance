import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../src/app.js';
import { closePool, query } from '../../src/db/pool.js';

/**
 * Integration tests.
 *
 * These require a migrated PostgreSQL database (`docker compose up -d` then
 * `npm run db:migrate`). They exercise the real HTTP stack, the real error
 * handler, and real SQL — no mocks — because the point is to prove the wiring
 * works end to end.
 */

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Start from a known state so results do not depend on earlier manual runs.
  // CASCADE is required because post_embeddings, suggestions, and eval_cases
  // all reference posts. Run this suite against a development database only.
  await query('TRUNCATE posts CASCADE');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // Leave the database as it was found so repeated runs stay deterministic.
  await query('TRUNCATE posts CASCADE');
  await closePool();
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

describe('database is migrated', () => {
  it('reports every migration as applied', async () => {
    const { rows } = await query('SELECT name FROM schema_migrations ORDER BY name');
    const names = rows.map((row) => row.name);

    assert.deepEqual(names, [
      '001_extensions_and_core.sql',
      '002_embeddings_and_suggestions.sql',
      '003_jobs_cost_and_eval.sql',
    ]);
  });

  it('has the pgvector extension installed', async () => {
    const { rows } = await query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    assert.equal(rows.length, 1);
    assert.match(rows[0].extversion, /^\d+\.\d+/);
  });

  it('has every core table', async () => {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`,
    );
    const tables = rows.map((row) => row.table_name).sort();

    assert.deepEqual(tables, [
      'ai_calls',
      'eval_cases',
      'image_embeddings',
      'image_metadata',
      'images',
      'jobs',
      'post_embeddings',
      'posts',
      'reviews',
      'suggestions',
    ]);
  });

  it('has the vector columns and HNSW indexes', async () => {
    const { rows: columns } = await query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'embedding'`,
    );
    assert.deepEqual(columns.map((row) => row.table_name).sort(), [
      'image_embeddings',
      'post_embeddings',
    ]);

    const { rows: indexes } = await query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE '%USING hnsw%'`,
    );
    assert.deepEqual(indexes.map((row) => row.indexname).sort(), [
      'idx_image_embeddings_vector',
      'idx_post_embeddings_vector',
    ]);
  });

  it('has the indexes the planned workflows rely on', async () => {
    const { rows } = await query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = rows.map((row) => row.indexname);

    for (const expected of [
      'idx_images_sha256',
      'idx_image_metadata_category',
      'idx_image_metadata_subject',
      'idx_suggestions_post_rank',
      'idx_jobs_status_created',
      'idx_ai_calls_created',
      'uq_image_metadata_model',
      'uq_image_embedding_model',
      'uq_post_embedding_model',
      'uq_reviews_suggestion',
      'uq_eval_post',
    ]) {
      assert.ok(names.includes(expected), `missing index ${expected}`);
    }
  });

  it('has every foreign key the schema depends on', async () => {
    const { rows } = await query(
      `SELECT conname FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND contype = 'f'
       ORDER BY conname`,
    );
    const names = rows.map((row) => row.conname);

    // Pinned as an exact set so a dropped or added FK cannot pass unnoticed.
    assert.deepEqual(names, [
      'ai_calls_job_id_fkey',
      'eval_cases_expected_image_id_fkey',
      'eval_cases_post_id_fkey',
      'image_embeddings_image_id_fkey',
      'image_metadata_image_id_fkey',
      'post_embeddings_post_id_fkey',
      'reviews_suggestion_id_fkey',
      'suggestions_image_id_fkey',
      'suggestions_post_id_fkey',
    ]);
  });

  it('deletes derived data by cascade but protects evidence by restrict', async () => {
    const { rows } = await query(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND contype = 'f'`,
    );
    const rule = Object.fromEntries(rows.map((row) => [row.conname, row.confdeltype]));

    // 'c' = CASCADE, 'r' = RESTRICT, 'n' = SET NULL, 'a' = NO ACTION.
    // Derived, regenerable data: an orphaned vector would corrupt the index.
    for (const fk of [
      'image_metadata_image_id_fkey',
      'image_embeddings_image_id_fkey',
      'post_embeddings_post_id_fkey',
    ]) {
      assert.equal(rule[fk], 'c', `${fk} should CASCADE`);
    }

    // Evidence: a recommendation, a human decision, and a curated label must not
    // disappear as a side effect of deleting their subject.
    for (const fk of [
      'suggestions_post_id_fkey',
      'suggestions_image_id_fkey',
      'reviews_suggestion_id_fkey',
      'eval_cases_post_id_fkey',
      'eval_cases_expected_image_id_fkey',
    ]) {
      assert.equal(rule[fk], 'r', `${fk} should RESTRICT`);
    }

    // A cost record outlives the job that produced it.
    assert.equal(rule.ai_calls_job_id_fkey, 'n', 'ai_calls.job_id should SET NULL');
  });

  it('enforces idempotency with unique indexes, not just application checks', async () => {
    const { rows } = await query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE '%UNIQUE%'
       ORDER BY indexname`,
    );
    const definitions = Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));

    // These are the rules that stop a retrying job creating duplicate records.
    const expected = {
      uq_image_metadata_model: '(image_id, model, model_version)',
      uq_image_embedding_model: '(image_id, model, model_version)',
      uq_post_embedding_model: '(post_id, model, model_version)',
      uq_reviews_suggestion: '(suggestion_id)',
      uq_eval_post: '(post_id)',
      suggestions_post_image_matcher_uniq: '(post_id, image_id, matcher_version)',
      posts_slug_key: '(slug)',
      jobs_idempotency_key_key: '(idempotency_key)',
    };

    for (const [name, columns] of Object.entries(expected)) {
      assert.ok(definitions[name], `missing unique index ${name}`);
      assert.ok(
        definitions[name].includes(columns),
        `${name} should be UNIQUE on ${columns}, got: ${definitions[name]}`,
      );
    }
  });

  it('rejects a duplicate logical record at the database level', async () => {
    const model = 'gemini-flash';
    const modelVersion = 'v1';

    const created = await call('POST', '/api/posts', {
      title: 'Idempotency Probe',
      content: 'Two embeddings for one post must not be insertable.',
    });
    const postId = created.body.id;

    const vector = `[${Array.from({ length: 768 }, (_, i) => ((i % 9) + 1) / 10).join(',')}]`;
    const insert = () =>
      query(
        `INSERT INTO post_embeddings (post_id, model, model_version, dimensions, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT DO NOTHING
         RETURNING 1`,
        [postId, model, modelVersion, 768, vector],
      );

    const first = await insert();
    const second = await insert();

    assert.equal(first.rows.length, 1, 'the first insert must succeed');
    assert.equal(second.rows.length, 0, 'a duplicate must be rejected by the database');
  });
});

describe('GET /health', () => {
  it('returns ok without needing the database', async () => {
    const { status, body } = await call('GET', '/health');

    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptimeSeconds, 'number');
  });
});

describe('GET /health/ready', () => {
  it('reports the database as reachable', async () => {
    const { status, body } = await call('GET', '/health/ready');

    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok', database: 'ok' });
  });
});

describe('POST /api/posts', () => {
  it('creates a post and returns the documented shape', async () => {
    const { status, body } = await call('POST', '/api/posts', {
      title: 'The Behavior of Red Foxes',
      content: 'Red foxes are small omnivorous canids that live in woodland.',
    });

    assert.equal(status, 201);
    assert.equal(body.status, 'CREATED');
    assert.equal(body.title, 'The Behavior of Red Foxes');
    assert.equal(body.slug, 'the-behavior-of-red-foxes');
    assert.match(body.id, /^[0-9a-f-]{36}$/);
  });

  it('returns the same field set as GET /api/posts/:id', async () => {
    const created = await call('POST', '/api/posts', {
      title: 'Shape Consistency Check',
      content: 'The create and read responses must not drift apart.',
    });
    const fetched = await call('GET', `/api/posts/${created.body.id}`);

    assert.deepEqual(Object.keys(created.body).sort(), [...Object.keys(fetched.body), 'status'].sort());
    assert.equal(created.body.content, 'The create and read responses must not drift apart.');
    assert.equal(created.body.updatedAt, fetched.body.updatedAt);
  });

  it('persists the post so it can be read back', async () => {
    const created = await call('POST', '/api/posts', {
      title: 'Wolves in Forest Ecosystems',
      content: 'Wolves are social canids that hunt in packs.',
    });
    assert.equal(created.status, 201);

    const fetched = await call('GET', `/api/posts/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, created.body.id);
    assert.equal(fetched.body.title, 'Wolves in Forest Ecosystems');
    assert.equal(fetched.body.content, 'Wolves are social canids that hunt in packs.');
  });

  it('derives a unique slug when the title is reused', async () => {
    const first = await call('POST', '/api/posts', {
      title: 'Bears and Hibernation',
      content: 'Bears hibernate through winter.',
    });
    const second = await call('POST', '/api/posts', {
      title: 'Bears and Hibernation',
      content: 'A second post with the same title.',
    });

    assert.equal(first.body.slug, 'bears-and-hibernation');
    assert.notEqual(second.body.slug, first.body.slug);
    assert.match(second.body.slug, /^bears-and-hibernation-[0-9a-f]{8}$/);
  });

  it('rejects a body with no title with a 400 VALIDATION_ERROR', async () => {
    const { status, body } = await call('POST', '/api/posts', { content: 'orphaned content' });

    assert.equal(status, 400, 'a validation problem must not become a 500');
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.error.details));
    assert.ok(body.error.details.some((detail) => detail.path === 'title'));
  });

  it('rejects an empty body', async () => {
    const { status, body } = await call('POST', '/api/posts', {});
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects an unknown field instead of ignoring it', async () => {
    const { status, body } = await call('POST', '/api/posts', {
      title: 'Valid',
      content: 'Valid content',
      unexpected: 'field',
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a wrong field type', async () => {
    const { status, body } = await call('POST', '/api/posts', { title: 'T', content: 42 });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });
});

describe('GET /api/posts/:id', () => {
  it('returns 404 for a well-formed id that does not exist', async () => {
    const { status, body } = await call('GET', '/api/posts/00000000-0000-4000-8000-000000000000');

    assert.equal(status, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  it('returns 400 for an id that is not a uuid', async () => {
    const { status, body } = await call('GET', '/api/posts/not-a-uuid');

    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'id');
  });
});

describe('GET /api/posts', () => {
  it('lists posts with pagination metadata', async () => {
    const { status, body } = await call('GET', '/api/posts?limit=2&offset=0');

    assert.equal(status, 200);
    assert.equal(body.limit, 2);
    assert.equal(body.offset, 0);
    assert.ok(body.total >= 2);
    assert.equal(body.posts.length, 2);
    assert.ok(body.posts[0].id);
    assert.ok('content' in body.posts[0]);
    assert.ok('createdAt' in body.posts[0]);
  });

  it('rejects an out-of-range limit with a 400', async () => {
    const { status, body } = await call('GET', '/api/posts?limit=1000');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });
});

describe('error contract', () => {
  it('returns the documented error shape for an unknown route', async () => {
    const { status, body } = await call('GET', '/api/does-not-exist');

    assert.equal(status, 404);
    assert.deepEqual(Object.keys(body), ['error']);
    assert.ok('code' in body.error);
    assert.ok('message' in body.error);
  });

  it('rejects malformed JSON with a 400 rather than a 500', async () => {
    const response = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });

  it('never leaks a stack trace in an error response', async () => {
    const { body } = await call('GET', '/api/posts/not-a-uuid');
    assert.ok(!JSON.stringify(body).includes('    at '));
  });
});

describe('corpus manifest is readable by the application', () => {
  it('parses and validates dataset/manifest.json', async () => {
    const { validateManifest } = await import('../../src/validators/manifest.validator.js');
    const parsed = JSON.parse(await readFile('dataset/manifest.json', 'utf8'));
    const result = validateManifest(parsed);

    assert.equal(result.success, true, JSON.stringify(result.issues));
  });
});
