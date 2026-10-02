/**
 * Provider-layer behaviour that does not need a database.
 *
 * Everything here was derived from failures observed against the live provider
 * during Phase 2, not from hypotheticals: the free tier really does answer with
 * "Please retry in 3h14m13s", and models really do wrap JSON in fences.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyQuota,
  extractCandidateText,
  isTransientStatus,
  ProviderError,
  parseJsonText,
  redactSecrets,
} from '../../src/ai/providers/geminiHttp.js';
import { l2Normalize } from '../../src/ai/providers/geminiEmbeddingProvider.js';
import { estimateCostUsd, hasPricing } from '../../src/ai/cost/pricing.js';
import { formatUsd } from '../../src/ai/cost/budgetGuard.js';

describe('classifyQuota', () => {
  // Verbatim shape returned during the Phase 2 corpus run.
  const OBSERVED = 'You exceeded your current quota, please check your plan and billing details. '
    + 'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n'
    + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, '
    + 'limit: 20, model: gemini-3.8-flash\n'
    + 'Please retry in 3h14m13.070992014s.';

  it('recognises real free-tier quota exhaustion and defers for the stated window', () => {
    const result = classifyQuota(OBSERVED, 429);
    assert.equal(result.quota, true);
    // 3h14m13.07s. Deferring for the provider's own window is the whole point:
    // retrying sooner cannot succeed.
    assert.equal(result.retryAfterMs, 11_653_071);
  });

  it('does not treat an ordinary 503 as a quota wall', () => {
    // This distinction is load-bearing. A 503 recovers in seconds and is worth
    // retrying; a quota wall does not, and retrying it is what failed 61 images.
    const result = classifyQuota(
      'This model is currently experiencing high demand. Spikes in demand are usually temporary.',
      503,
    );
    assert.equal(result.quota, undefined);
  });

  it('does not treat a revoked key as retryable', () => {
    assert.equal(classifyQuota('API key not valid', 401).quota, undefined);
    assert.equal(isTransientStatus(401), false);
  });

  it('parses minute and second-only windows', () => {
    assert.equal(classifyQuota('quota exceeded, retry in 2m30s', 429).retryAfterMs, 150_000);
    // Floored to one minute, not shortened: a provider asking for 45s still
    // gets 60s, because anything tighter risks a retry loop against a limit
    // that has not reset.
    assert.equal(classifyQuota('quota exceeded, retry in 45s', 429).retryAfterMs, 60_000);
  });

  it('falls back to an hour when a quota wall states no window', () => {
    // Better to wait too long than to build a tight retry loop against a limit
    // that is known not to have reset.
    assert.equal(
      classifyQuota('Resource has been exhausted (e.g. check quota).', 429).retryAfterMs,
      3_600_000,
    );
  });

  it('never returns a deferral shorter than a minute', () => {
    assert.ok(classifyQuota('quota exceeded, retry in 0s', 429).retryAfterMs >= 60_000);
  });

  it('leaves non-quota 429 rate limiting to ordinary backoff', () => {
    // Per-minute rate limiting recovers on its own and should not park a job
    // for an hour.
    assert.equal(classifyQuota('Rate limit exceeded', 429).quota, undefined);
    assert.equal(isTransientStatus(429), true);
  });
});

describe('isTransientStatus', () => {
  it('retries server-side faults and rate limiting', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      assert.equal(isTransientStatus(status), true, `expected ${status} to be retryable`);
    }
  });

  it('does not retry client mistakes', () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      assert.equal(isTransientStatus(status), false, `expected ${status} to be permanent`);
    }
  });
});

describe('ProviderError', () => {
  it('carries the fields the job runner and cost tracker depend on', () => {
    const error = new ProviderError('boom', {
      provider: 'gemini', model: 'm', status: 503, transient: true,
    });
    assert.equal(error.name, 'ProviderError');
    assert.equal(error.transient, true);
    assert.equal(error.quota, false);
    assert.ok(error instanceof Error);
  });
});

describe('parseJsonText', () => {
  // Returns a result object rather than throwing. Malformed model output is an
  // expected, recorded outcome — a reason string the caller persists alongside
  // the ai_calls row — not an exception. Throwing here would mean every invalid
  // response took the job-failure path instead of the INVALID-classification
  // path.
  it('parses plain JSON', () => {
    assert.deepEqual(parseJsonText('{"subject":"fox"}'), { ok: true, value: { subject: 'fox' } });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    // Observed in practice: models wrap structured output despite the schema.
    const fenced = '```json\n{"subject":"fox","confidence":0.9}\n```';
    assert.deepEqual(parseJsonText(fenced), {
      ok: true,
      value: { subject: 'fox', confidence: 0.9 },
    });
  });

  it('parses a fence without a language tag', () => {
    assert.deepEqual(parseJsonText('```\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  });

  it('reports non-JSON as a failure with a reason', () => {
    const result = parseJsonText('the image shows a fox');
    assert.equal(result.ok, false);
    assert.match(result.reason, /not valid JSON/i);
  });

  it('reports empty output instead of treating it as an empty classification', () => {
    // An empty string must never become { ok: true, value: undefined }, which
    // would flow onward as a successful call with no data.
    const result = parseJsonText('');
    assert.equal(result.ok, false);
    assert.match(result.reason, /empty/i);
  });

  it('does not repair truncated output', () => {
    // Deliberately narrow. Repairing truncated JSON would manufacture a valid
    // object out of a truncated model response, which is precisely what
    // requirement 1 forbids.
    assert.equal(parseJsonText('{"subject":"fox","confidence":0.9').ok, false);
  });
});

describe('redactSecrets', () => {
  it('strips an API key from text destined for the database', () => {
    const text = 'failed with key AIzaSyTESTKEY1234567890abcdef';
    const cleaned = redactSecrets(text);
    assert.ok(!cleaned.includes('AIzaSyTESTKEY1234567890abcdef'));
    assert.match(cleaned, /\[redacted\]/);
  });

  it('strips a key= parameter', () => {
    assert.ok(!redactSecrets('url?key=AIzaSyTESTKEY1234567890abcdef').includes('AIzaSyTESTKEY'));
  });

  it('leaves ordinary error text alone', () => {
    const text = 'This model is currently experiencing high demand.';
    assert.equal(redactSecrets(text), text);
  });
});

describe('l2Normalize', () => {
  it('normalises to unit length', () => {
    // gemini-embedding-001 returns 768 dimensions that are NOT pre-normalised.
    // An unnormalised vector makes cosine similarity behave inconsistently, so
    // this normalisation is load-bearing rather than cosmetic.
    const vector = l2Normalize([3, 4]);
    assert.equal(vector.length, 2);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-12);
  });

  it('preserves dimension count at the real embedding width', () => {
    const vector = l2Normalize(Array.from({ length: 768 }, (_, i) => i + 1));
    assert.equal(vector.length, 768);
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-9);
  });

  it('rejects a zero vector rather than dividing by zero', () => {
    assert.throws(() => l2Normalize([0, 0, 0]), /zero/i);
  });

  it('rejects an empty vector', () => {
    assert.throws(() => l2Normalize([]));
  });
});

describe('extractCandidateText', () => {
  it('reads the text from the first candidate', () => {
    assert.equal(
      extractCandidateText({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }),
      'hello',
    );
  });

  it('joins multiple parts', () => {
    assert.equal(
      extractCandidateText({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }),
      'ab',
    );
  });

  it('returns an empty string for an empty candidate list', () => {
    // Safe by composition rather than by throwing: '' flows into parseJsonText,
    // which reports "model returned empty text" and becomes an INVALID
    // classification. A throw here would instead be recorded as a job failure,
    // which is a different and misleading outcome.
    assert.equal(extractCandidateText({ candidates: [] }), '');
    assert.equal(parseJsonText(extractCandidateText({ candidates: [] })).ok, false);
  });

  it('returns an empty string for a payload with no candidates key', () => {
    assert.equal(extractCandidateText({}), '');
    assert.equal(extractCandidateText(null), '');
  });
});

describe('estimateCostUsd', () => {
  it('prices a known model from its token counts', () => {
    const cost = estimateCostUsd('gemini-3.5-flash', { inputTokens: 1_000_000, outputTokens: 0 });
    assert.ok(cost > 0, 'a priced model must not be reported as free');
  });

  it('returns 0 for an unpriced model instead of guessing', () => {
    assert.equal(estimateCostUsd('some-local-model', { inputTokens: 1_000 }), 0);
    assert.equal(hasPricing('some-local-model'), false);
  });

  it('returns 0 when usage is missing', () => {
    assert.equal(estimateCostUsd('gemini-3.5-flash', null), 0);
    assert.equal(estimateCostUsd('gemini-3.5-flash', {}), 0);
  });

  it('never returns a negative cost', () => {
    const cost = estimateCostUsd('gemini-3.5-flash', { inputTokens: -5, outputTokens: -5 });
    assert.ok(cost >= 0);
  });
});

describe('formatUsd', () => {
  it('formats a dollar amount', () => {
    assert.equal(formatUsd(1.5), '$1.5000');
    assert.equal(formatUsd(0), '$0.0000');
  });
});