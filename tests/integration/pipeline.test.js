/**
 * Phase 2 pipeline integration tests.
 *
 * Real PostgreSQL, real job runner, real service layer — and stub providers, so
 * the suite needs no API key and spends nothing. The stubs are not a
 * convenience here; they are what makes it possible to assert the failure paths
 * that matter. A 503 and a 3-hour quota wall cannot be provoked on demand
 * against a real provider, and those are exactly the paths worth testing.
 *
 * Requires a migrated database: `docker compose up -d && npm run db:migrate`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closePool, query } from '../../src/db/pool.js';
import { registerHandler, runOnce, runUntilEmpty } from '../../src/jobs/jobRunner.js';
import { ProviderError } from '../../src/ai/providers/geminiHttp.js';
import { EMBEDDING_DIMENSION } from '../../src/config/constants.js';
import * as imagesRepository from '../../src/repositories/images.repository.js';
import * as jobsRepository from '../../src/repositories/jobs.repository.js';
import * as aiCallsRepository from '../../src/repositories/aiCalls.repository.js';
import { createVisionJobHandler } from '../../src/jobs/jobHandlers/index.js';
import { analyseImage, embedImageCaption } from '../../src/services/vision.service.js';

/**
 * Build a throwaway image row.
 *
 * sha256 must be 64 hex characters (images_sha256_check) and is deliberately NOT
 * unique — two manifest entries may reference the same bytes — so each fixture
 * gets its own deterministic value.
 */
let imageCounter = 0;

function fakeSha256(seed) {
  return String(seed).padStart(64, '0').slice(0, 64);
}

/**
 * analyseImage reads the image bytes before calling the provider, so the fixture
 * needs a real file on disk. A 1x1 JPEG is enough: the stub providers never look
 * at the content, and writing a genuine binary here is cheaper and more honest
 * than stubbing the filesystem.
 */
let fixtureDir;

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

async function makeImage(overrides = {}) {
  imageCounter += 1;

  const storageKey = overrides.storage_key ?? join(fixtureDir, `fixture-${imageCounter}.jpg`);
  if (!overrides.storage_key) {
    await writeFile(storageKey, TINY_JPEG);
  }

  const { rows } = await query(
    `INSERT INTO images
       (original_filename, storage_key, mime_type, byte_size, width, height, sha256, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, original_filename, storage_key, status`,
    [
      overrides.original_filename ?? 'test.jpg',
      storageKey,
      overrides.mime_type ?? 'image/jpeg',
      overrides.byte_size ?? 1024,
      overrides.width ?? 800,
      overrides.height ?? 600,
      overrides.sha256 ?? fakeSha256(imageCounter),
      overrides.status ?? 'PENDING',
    ],
  );
  return rows[0];
}

const VALID_OUTPUT = {
  subject: 'fox',
  category: 'wildlife',
  attributes: ['red fur', 'pointed ears'],
  caption: 'A red fox standing in tall grass.',
  confidence: 0.93,
};

/** A provider stub whose behaviour each test dictates. */
function stubVision(behaviour) {
  return {
    name: 'stub',
    model: 'stub-vision-test',
    async understandImage() {
      return behaviour();
    },
  };
}

function stubEmbedding(vector) {
  return {
    name: 'stub',
    model: 'stub-embedding-test',
    async embedText() {
      return {
        vector: vector ?? Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i % 7) / 10),
        usage: { inputTokens: 20, outputTokens: 0 },
      };
    },
  };
}

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'flyrank-pipeline-'));

  // Leave the database as found so repeated runs stay deterministic. Only rows
  // this suite's own fixtures create are removed, and images is left alone
  // because a real corpus may be present.
  await query(`DELETE FROM jobs`);
  await query(`DELETE FROM ai_calls`);
});

after(async () => {
  await query(`DELETE FROM jobs`);
  await closePool();
});

describe('analyseImage: invalid provider output', () => {
  it('persists no metadata row when the model output fails validation', async () => {
    // This is the core Phase 2 guarantee. "Invalid output is never silently
    // accepted" is enforced by the absence of a row, not by a branch that was
    // hopefully taken.
    const image = await makeImage();
    const provider = stubVision(() => ({
      rawOutput: { ...VALID_OUTPUT, subject: 'dragon' },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    const result = await analyseImage({ image, visionProvider: provider });

    assert.equal(result.status, 'INVALID');

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM image_metadata WHERE image_id = $1',
      [image.id],
    );
    assert.equal(rows[0].n, 0, 'an unvalidated response must leave no metadata behind');
  });

  it('still records the raw response as a call, so the failure is inspectable', async () => {
    const image = await makeImage();
    const provider = stubVision(() => ({
      rawOutput: { subject: 'dragon' },
      usage: { inputTokens: 11, outputTokens: 4 },
    }));

    await analyseImage({ image, visionProvider: provider });

    const { rows } = await query(
      'SELECT status, input_units, output_units FROM ai_calls ORDER BY created_at DESC LIMIT 1',
    );
    assert.equal(Number(rows[0].input_units), 11);
  });

  it('marks a low-confidence response FLAGGED rather than discarding it', async () => {
    // A flagged image must stay visible so a reviewer can judge it; discarding
    // it would make the model's uncertainty invisible.
    const image = await makeImage();
    const provider = stubVision(() => ({
      rawOutput: { ...VALID_OUTPUT, confidence: 0.2 },
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    const result = await analyseImage({ image, visionProvider: provider });

    assert.equal(result.status, 'LOW_CONFIDENCE');
    assert.equal(result.persisted, true, 'a flagged analysis is stored, not discarded');

    const { rows } = await query(
      'SELECT validation_status, confidence FROM image_metadata WHERE image_id = $1',
      [image.id],
    );
    assert.equal(rows[0].validation_status, 'LOW_CONFIDENCE');
    assert.equal(Number(rows[0].confidence), 0.2);
  });

  it('stores a valid analysis as VALID and READY', async () => {
    const image = await makeImage();
    const provider = stubVision(() => ({
      rawOutput: VALID_OUTPUT,
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    const result = await analyseImage({ image, visionProvider: provider });
    assert.equal(result.status, 'VALID');

    const { rows } = await query('SELECT status FROM images WHERE id = $1', [image.id]);
    assert.equal(rows[0].status, 'READY');
  });

  it('records a second call for the same image without duplicating the row', async () => {
    // Idempotency: one analysis per (image, model, model_version, prompt_version).
    const image = await makeImage();
    const provider = stubVision(() => ({
      rawOutput: VALID_OUTPUT,
      usage: { inputTokens: 10, outputTokens: 5 },
    }));

    await analyseImage({ image, visionProvider: provider });
    await analyseImage({ image, visionProvider: provider });

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM image_metadata WHERE image_id = $1',
      [image.id],
    );
    assert.equal(rows[0].n, 1);
  });
});

describe('job runner: quota exhaustion', () => {
  it('defers the job without consuming an attempt', async () => {
    // The behaviour that the first real run got wrong. Retrying a 3-hour quota
    // wall three times failed all 61 images permanently, none of which had been
    // analysed.
    const image = await makeImage();
    const quotaError = new ProviderError(
      'Quota exceeded for metric: ...free_tier_requests, limit: 20\nPlease retry in 3h14m13s.',
      {
        provider: 'stub', model: 'stub-vision-test', status: 429,
        transient: true, quota: true, retryAfterMs: 11_653_000,
      },
    );

    registerHandler(
      'test.quota',
      async () => { throw quotaError; },
    );

    const key = `quota-${image.id}`;
    await jobsRepository.enqueueJob({
      type: 'test.quota', entityType: 'image', entityId: image.id,
      idempotencyKey: key, maxAttempts: 3,
    });

    const outcome = await runOnce({ type: 'test.quota' });

    assert.equal(outcome.outcome, 'deferred');

    const job = await jobsRepository.findJobById(outcome.job.id);
    assert.equal(job.status, 'PENDING', 'a deferred job must be claimable later');
    assert.equal(job.attempts, 0, 'a quota block must not spend the attempt budget');
    assert.ok(job.reclaimable_at, 'a deferred job must record when it becomes claimable');
    assert.ok(job.reclaimable_at > new Date(), 'it must be parked in the future');

    // And it must not be claimable right now.
    const reclaimed = await jobsRepository.claimNextJob({ type: 'test.quota' });
    assert.equal(reclaimed, null);
  });

  it('reclaims a deferred job once its window has passed', async () => {
    const image = await makeImage();
    const quotaError = new ProviderError('quota', {
      provider: 'stub', model: 'm', status: 429, transient: true,
      quota: true, retryAfterMs: 60_000,
    });

    registerHandler('test.quota-reclaim', async () => { throw quotaError; });

    await jobsRepository.enqueueJob({
      type: 'test.quota-reclaim', entityType: 'image', entityId: image.id,
      idempotencyKey: `quota-reclaim-${image.id}`, maxAttempts: 3,
    });

    await runOnce({ type: 'test.quota-reclaim' });

    // Move the window into the past rather than waiting a minute.
    await query(
      `UPDATE jobs SET reclaimable_at = NOW() - INTERVAL '1 minute'
       WHERE idempotency_key = $1`,
      [`quota-reclaim-${image.id}`],
    );

    const reclaimed = await jobsRepository.claimNextJob({ type: 'test.quota-reclaim' });
    assert.ok(reclaimed, 'the job must become claimable again after its window');
    assert.equal(reclaimed.attempts, 1);
  });

  it('stops the batch on quota rather than working through the whole queue', async () => {
    // The limit is per model, so every remaining job would hit the same wall.
    // Continuing would defer 60 more jobs one at a time and bury the message.
    let calls = 0;
    registerHandler('test.quota-batch', async () => {
      calls += 1;
      throw new ProviderError('quota exceeded', {
        provider: 'stub', model: 'm', status: 429, transient: true,
        quota: true, retryAfterMs: 3_600_000,
      });
    });

    for (let i = 0; i < 5; i += 1) {
      const image = await makeImage();
      await jobsRepository.enqueueJob({
        type: 'test.quota-batch', entityType: 'image', entityId: image.id,
        idempotencyKey: `quota-batch-${image.id}`, maxAttempts: 3,
      });
    }

    const summary = await runUntilEmpty({ type: 'test.quota-batch' });

    assert.equal(summary.stoppedByQuota, true);
    assert.equal(summary.deferred, 1);
    assert.equal(calls, 1, 'the batch must stop after the first quota wall');

    await query(`DELETE FROM jobs WHERE type = 'test.quota-batch'`);
  });
});

describe('job runner: retry policy', () => {
  it('retries a transient failure and preserves the attempt', async () => {
    const image = await makeImage();
    let calls = 0;

    registerHandler('test.retry', async () => {
      calls += 1;
      throw new ProviderError('high demand', {
        provider: 'stub', model: 'm', status: 503, transient: true,
      });
    });

    await jobsRepository.enqueueJob({
      type: 'test.retry', entityType: 'image', entityId: image.id,
      idempotencyKey: `retry-${image.id}`, maxAttempts: 3,
    });

    const outcome = await runOnce({ type: 'test.retry' });
    assert.equal(outcome.outcome, 'retry');
    assert.equal(calls, 1);

    const job = await jobsRepository.findJobById(outcome.job.id);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 1, 'a genuine attempt was made and must be counted');
  });

  it('fails immediately on a permanent error instead of burning attempts', async () => {
    const image = await makeImage();
    let calls = 0;

    registerHandler('test.permanent', async () => {
      calls += 1;
      throw new ProviderError('API key not valid', {
        provider: 'stub', model: 'm', status: 401, transient: false,
      });
    });

    await jobsRepository.enqueueJob({
      type: 'test.permanent', entityType: 'image', entityId: image.id,
      idempotencyKey: `permanent-${image.id}`, maxAttempts: 3,
    });

    const outcome = await runOnce({ type: 'test.permanent' });
    assert.equal(outcome.outcome, 'failed');
    assert.equal(calls, 1);
  });

  it('reports a job cap honestly instead of claiming completion', async () => {
    const image = await makeImage();
    registerHandler('test.cap', async () => ({ ok: true }));

    for (let i = 0; i < 3; i += 1) {
      await jobsRepository.enqueueJob({
        type: 'test.cap', entityType: 'image', entityId: image.id,
        idempotencyKey: `cap-${image.id}-${i}`, maxAttempts: 3,
      });
    }

    const summary = await runUntilEmpty({ type: 'test.cap', maxJobs: 2 });

    assert.equal(summary.completed, 2);
    assert.equal(summary.hitJobCap, true);
    await query(`DELETE FROM jobs WHERE type = 'test.cap'`);
  });

  it('does not deliver one job to two concurrent workers', async () => {
    const image = await makeImage();
    registerHandler('test.concurrent', async () => ({ ok: true }));

    for (let i = 0; i < 2; i += 1) {
      await jobsRepository.enqueueJob({
        type: 'test.concurrent', entityType: 'image', entityId: image.id,
        idempotencyKey: `concurrent-${image.id}-${i}`, maxAttempts: 3,
      });
    }

    const [a, b] = await Promise.all([
      jobsRepository.claimNextJob({ type: 'test.concurrent' }),
      jobsRepository.claimNextJob({ type: 'test.concurrent' }),
    ]);

    assert.ok(a && b, 'both claims should succeed');
    assert.notEqual(a.id, b.id, 'FOR UPDATE SKIP LOCKED must not hand out the same row');
    await query(`DELETE FROM jobs WHERE type = 'test.concurrent'`);
  });
});

describe('job runner: image status recovery', () => {
  it('returns the image to PENDING when the attempt fails', async () => {
    // Otherwise 61 images sat in PROCESSING while every corresponding job was
    // FAILED, which reads as a corrupt database rather than a throttled run.
    const image = await makeImage();
    const handler = createVisionJobHandler({
      visionProvider: stubVision(() => { throw new ProviderError('boom', { transient: true }); }),
    });

    registerHandler('test.status', handler);
    await jobsRepository.enqueueJob({
      type: 'test.status', entityType: 'image', entityId: image.id,
      idempotencyKey: `status-${image.id}`, maxAttempts: 3,
    });

    await runOnce({ type: 'test.status' });

    const { rows } = await query('SELECT status FROM images WHERE id = $1', [image.id]);
    assert.equal(rows[0].status, 'PENDING');
    await query(`DELETE FROM jobs WHERE type = 'test.status'`);
  });
});

describe('embedImageCaption', () => {
  it('embeds the analysis named on the job', async () => {
    const image = await makeImage();
    await analyseImage({
      image,
      visionProvider: stubVision(() => ({
        rawOutput: VALID_OUTPUT, usage: { inputTokens: 10, outputTokens: 5 },
      })),
    });

    const metadata = await imagesRepository.findImageMetadata(image.id, {
      model: 'stub-vision-test',
    });

    const result = await embedImageCaption({
      image,
      embeddingProvider: stubEmbedding(),
      metadataId: metadata.id,
    });

    assert.equal(result.dimensions, EMBEDDING_DIMENSION);

    // Asserted against the table rather than the return value: the requirement
    // is that the vector is PERSISTED, and a function that returned a vector
    // without writing it would pass a shape-only check.
    const { rows } = await query(
      `SELECT count(*)::int AS n, max(dimensions) AS dimensions
       FROM image_embeddings WHERE image_id = $1`,
      [image.id],
    );
    assert.equal(rows[0].n, 1, 'the vector must be persisted, not merely returned');
    assert.equal(rows[0].dimensions, EMBEDDING_DIMENSION);
  });

  it('refuses to embed a caption that failed validation', async () => {
    // Defence in depth: ingestion only ever selects VALID/LOW_CONFIDENCE rows,
    // so reaching here means something upstream changed. An INVALID analysis
    // must never become a vector.
    const image = await makeImage();
    await analyseImage({
      image,
      visionProvider: stubVision(() => ({
        rawOutput: { ...VALID_OUTPUT, subject: 'dragon' },
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    });

    await assert.rejects(
      embedImageCaption({
        image,
        embeddingProvider: stubEmbedding(),
        visionModel: 'stub-vision-test',
      }),
      /no validated vision analysis/i,
    );
  });

  it('stores the source text alongside the vector', async () => {
    // Without this a stored vector cannot be traced to the caption that produced
    // it, which would make a Phase 4 precision figure irreproducible.
    const image = await makeImage();
    await analyseImage({
      image,
      visionProvider: stubVision(() => ({
        rawOutput: VALID_OUTPUT, usage: { inputTokens: 10, outputTokens: 5 },
      })),
    });

    const metadata = await imagesRepository.findImageMetadata(image.id, {
      model: 'stub-vision-test',
    });

    await embedImageCaption({
      image, embeddingProvider: stubEmbedding(), metadataId: metadata.id,
    });

    const { rows } = await query(
      'SELECT source_text FROM image_embeddings WHERE image_id = $1',
      [image.id],
    );
    assert.match(rows[0].source_text, /fox/);
  });

  it('fails clearly when there is nothing to embed', async () => {
    const image = await makeImage();
    await assert.rejects(
      embedImageCaption({ image, embeddingProvider: stubEmbedding() }),
      /no validated vision analysis/i,
    );
  });
});

describe('cost tracking', () => {
  it('records a call for a successful provider response', async () => {
    const image = await makeImage();
    await analyseImage({
      image,
      visionProvider: stubVision(() => ({
        rawOutput: VALID_OUTPUT, usage: { inputTokens: 123, outputTokens: 45 },
      })),
    });

    const { rows } = await query(
      `SELECT status, input_units, output_units, operation
       FROM ai_calls WHERE operation = 'vision.understand'
       ORDER BY created_at DESC LIMIT 1`,
    );
    // Counters are NUMERIC/BIGINT, so pg hands them back as strings.
    assert.equal(rows[0].status, 'SUCCESS');
    assert.equal(Number(rows[0].input_units), 123);
    assert.equal(Number(rows[0].output_units), 45);
  });

  it('records a FAILED call when the provider throws', async () => {
    const image = await makeImage();

    await assert.rejects(
      analyseImage({
        image,
        visionProvider: stubVision(() => { throw new Error('network down'); }),
      }),
    );

    const { rows } = await query(
      `SELECT status, error FROM ai_calls
       WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(rows.length > 0, 'a failed provider call must leave a cost record');
    assert.match(rows[0].error, /network down/);
  });

  it('redacts a credential from a persisted error', async () => {
    const image = await makeImage();

    await assert.rejects(
      analyseImage({
        image,
        visionProvider: stubVision(() => {
          throw new ProviderError('rejected key AIzaSyTESTKEY1234567890abcdef', {
            provider: 'stub', model: 'm', status: 400,
          });
        }),
      }),
    );

    const { rows } = await query(
      `SELECT error FROM ai_calls WHERE status = 'FAILED'
       ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(!rows[0].error.includes('AIzaSyTESTKEY1234567890abcdef'));
  });

  it('aggregates totals and per-model breakdown', async () => {
    const totals = await aiCallsRepository.summariseAiCalls();
    assert.ok(totals.total_calls > 0);

    const byModel = await aiCallsRepository.summariseAiCallsByModel();
    assert.ok(Array.isArray(byModel));
  });

  it('applies a time window', async () => {
    // Regression guard: the window was once built as
    // `NOW() INTERVAL '1 day'`, which is a syntax error because interval
    // addition needs '+'.
    await assert.doesNotReject(() => aiCallsRepository.summariseAiCalls({ windowInterval: '1 day' }));
    await assert.doesNotReject(() => aiCallsRepository.summariseAiCallsByModel({ windowInterval: '1 month' }));
  });
});