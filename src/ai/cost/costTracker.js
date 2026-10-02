/**
 * AI call cost tracking.
 *
 * Wraps every provider call so that a cost record is written on success AND on
 * failure (docs/AI-PIPELINE.md, "Cost tracking"). Two properties matter:
 *
 *  1. The caller's result is returned unchanged. Tracking must never alter
 *     behaviour it observes, or a bug in the cost layer becomes a bug in the
 *     pipeline.
 *
 *  2. A failure that still consumed tokens is recorded with those tokens. A 503
 *     costs nothing and a 429 costs nothing, but a truncated response costs
 *     output tokens, and an error raised after a successful parse costs input
 *     tokens. Dropping those under-reports exactly the events an operator needs
 *     to see.
 */

import { logger } from '../../utils/logger.js';
import * as aiCallsRepository from '../../repositories/aiCalls.repository.js';
import { estimateCostUsd, hasPricing } from './pricing.js';
import { redactSecrets } from '../providers/geminiHttp.js';

/** Trim an error to something safe and bounded for a TEXT column. */
const MAX_ERROR_LENGTH = 2_000;

/**
 * @typedef {object} TrackedCall
 * @property {string} provider
 * @property {string} model
 * @property {string} operation e.g. 'vision.understand' | 'embedding.embed'
 * @property {string | null} [jobId]
 * @property {boolean} [failFast] never swallowed; rethrows after recording
 */

/**
 * Execute a provider call and persist its cost record.
 *
 * `fn` must resolve to the provider's own response object, which by convention
 * carries a `usage` property alongside its payload — `{ rawOutput, usage }` for
 * vision, `{ vector, usage }` for embeddings. That object is returned UNCHANGED,
 * so tracking cannot alter behaviour it observes.
 *
 * Getting this contract wrong is silent: an earlier version destructured
 * `{ result, usage }`, which no provider returns, so `result` was always
 * undefined and every caller that destructured the response got a TypeError
 * *after* the provider had succeeded and the cost row had been written. The
 * resulting ai_calls table looked healthy — 6 SUCCESS rows — while zero images
 * were analysed. This shape avoids reintroducing that class of bug: usage is
 * read from the same object that is handed back.
 *
 * @template T
 * @param {TrackedCall} call
 * @param {() => Promise<T>} fn resolves to `{ ...payload, usage }`
 * @returns {Promise<T>} exactly what `fn` resolved to
 */
export async function trackCall({ provider, model, operation, jobId = null }, fn) {
  let outcome;

  try {
    const response = await fn();
    outcome = { ok: true, response, usage: response?.usage ?? null };
  } catch (error) {
    // Any usage attached to the error is still billed. Providers do not
    // consistently return it on failure, but Gemini includes usageMetadata on
    // some error paths and it would be wrong to discard it.
    outcome = { ok: false, error, usage: error?.usage ?? null };
  }

  const usage = outcome.usage ?? {};
  const inputUnits = usage.inputTokens ?? null;
  const outputUnits = usage.outputTokens ?? null;
  const estimatedCostUsd = estimateCostUsd(model, usage);

  await persistAiCall({
    jobId,
    provider,
    model,
    operation,
    inputUnits,
    outputUnits,
    estimatedCostUsd,
    status: outcome.ok ? 'SUCCESS' : 'FAILED',
    error: outcome.ok ? null : describeError(outcome.error),
  });

  if (!hasPricing(model)) {
    // A new or locally-defined model should not silently cost $0 forever.
    logger.warn('No pricing configured for model; recorded cost as 0', { model, operation });
  }

  if (outcome.ok) {
    return outcome.response;
  }

  throw outcome.error;
}

/**
 * Persist an ai_calls row without letting a bookkeeping failure mask the call.
 *
 * When `rethrowOriginal` is false the original error is rethrown even if
 * recording failed, because losing the provider's real error message to a
 * database problem would be the worse outcome.
 *
 * @param {object} record
 * @param {object} [options]
 * @param {boolean} [options.rethrowOnRecordFailure]
 */
async function persistAiCall(record, { rethrowOnRecordFailure = false } = {}) {
  try {
    return await aiCallsRepository.insertAiCall(record);
  } catch (recordError) {
    logger.error('Failed to persist ai_calls record', {
      error: recordError.message,
      provider: record.provider,
      model: record.model,
      operation: record.operation,
      status: record.status,
    });

    if (rethrowOnRecordFailure && !record.error) {
      throw recordError;
    }
  }

  return null;
}

/**
 * Build the persisted `error` string.
 *
 * ai_calls_error_required_on_failure is a CHECK constraint, so a FAILED row must
 * carry a non-null error. Every failure path therefore needs a string even when
 * the thrown value has no message.
 */
export function describeError(error) {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error ?? 'unknown error'),
  );

  const status = error?.status ? ` (HTTP ${error.status})` : '';
  const transient = error?.transient === true ? ' [transient]' : '';

  return `${message}${status}${transient}`.slice(0, MAX_ERROR_LENGTH);
}

export { persistAiCall };