/**
 * Background job runner.
 *
 * Claims jobs, dispatches them to a registered handler, and records the outcome
 * with retry. Three properties the phase document requires, and where each one
 * lives:
 *
 *   asynchronous  the runner is invoked from a CLI batch script, never from a
 *                 request handler. Requirement: "slow AI work must not block
 *                 normal HTTP requests".
 *   retries       transient failures return the job to PENDING with backoff;
 *                 permanent ones fail immediately.
 *   progress      updateJobProgress writes to jobs.progress, which the jobs API
 *                 and the batch script both read.
 *
 * Retry policy is deliberately asymmetric. A 503 "high demand" was observed from
 * a real Gemini model during this phase, and is worth retrying. A 401 from a
 * revoked key is not: retrying it three times across 61 images means 183 doomed
 * requests before an operator sees a useful message.
 */

import { AI_RETRY_BASE_DELAY_MS } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import * as jobsRepository from '../repositories/jobs.repository.js';

/** @type {Map<string, (context: object) => Promise<object>>} */
const handlers = new Map();

/**
 * Register the handler for a job type.
 *
 * @param {string} type
 * @param {(context: { job: object, signal: AbortSignal, attempt: number, maxAttempts: number }) => Promise<object>} handler
 */
export function registerHandler(type, handler) {
  handlers.set(type, handler);
}

export function hasHandler(type) {
  return handlers.has(type);
}

/**
 * Should this failure be retried?
 *
 * Three conditions, all required:
 *   1. the error is marked transient (a 4xx is not retryable however many
 *      attempts remain),
 *   2. attempts remain,
 *   3. the job is configured to allow them.
 *
 * @param {object} job
 * @param {any} error
 */
export function shouldRetry(job, error) {
  if (error?.transient !== true) {
    return false;
  }

  return job.attempts < job.max_attempts;
}

/**
 * Exponential backoff, capped.
 *
 * Capped because an unbounded doubling would push attempt 6 past 100 seconds and
 * hold the batch open longer than the work it is protecting.
 */
export function backoffDelayMs(attempts, { baseMs = AI_RETRY_BASE_DELAY_MS, capMs = 30_000 } = {}) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Claim and run at most one job.
 *
 * @param {object} [options]
 * @param {string} [options.type] restrict to one job type
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ outcome: 'completed' | 'retry' | 'failed' | 'idle', job: object | null, result?: object, error?: unknown }>}
 */
export async function runOnce({ type, signal } = {}) {
  const job = await jobsRepository.claimNextJob({ type });

  if (!job) {
    return { outcome: 'idle', job: null };
  }

  const handler = handlers.get(job.type);

  if (!handler) {
    // Not transient: a missing handler is a deployment mistake, and retrying
    // would reproduce the same crash once per attempt.
    const message = `no handler registered for job type '${job.type}'`;
    const failed = await jobsRepository.failJobAttempt(job.id, {
      error: message,
      willRetry: false,
    });
    logger.error('Job failed: unregistered handler', { jobId: job.id, type: job.type });
    return { outcome: 'failed', job: failed, error: new Error(message) };
  }

  logger.debug('Job claimed', {
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    entityId: job.entity_id,
  });

  try {
    const result = await handler({
      job,
      signal,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      updateProgress: (progress) => jobsRepository.updateJobProgress(job.id, progress),
    });

    const completed = await jobsRepository.completeJob(job.id, { progress: 100 });
    return { outcome: 'completed', job: completed, result };
  } catch (error) {
    const message = describeJobFailure(error);

    // Provider quota exhaustion is handled before retry policy. It is not a
    // flaky failure and it is not the job's fault: the free tier allows 20
    // requests per model and then answers "Please retry in 3h14m13s". Retrying
    // in 2s cannot succeed, and doing so spends all three attempts and
    // permanently fails 61 images that were never analysed. So the attempt is
    // handed back and the job is parked for the window the API itself stated.
    if (error?.quota === true) {
      const delayMs = error.retryAfterMs ?? QUOTA_FALLBACK_DELAY_MS;
      const deferred = await jobsRepository.deferJob(job.id, { error: message, delayMs });

      logger.warn('Provider quota exhausted; deferring job', {
        jobId: job.id,
        type: job.type,
        model: error.model,
        deferMs: delayMs,
        error: message,
      });

      return { outcome: 'deferred', job: deferred, error, delayMs };
    }

    const retry = shouldRetry(job, error);

    const updated = await jobsRepository.failJobAttempt(job.id, {
      error: message,
      willRetry: retry,
    });

    if (retry) {
      const delay = backoffDelayMs(job.attempts);
      logger.warn('Job attempt failed, will retry', {
        jobId: job.id,
        type: job.type,
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        retryInMs: delay,
        error: message,
      });

      return { outcome: 'retry', job: updated, error };
    }

    logger.error('Job failed permanently', {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      transient: error?.transient === true,
      error: message,
    });

    return { outcome: 'failed', job: updated, error };
  }
}

/**
 * Run jobs until the queue for `type` is empty.
 *
 * Bounded by maxJobs so a misconfigured producer that enqueues work forever
 * cannot turn a batch script into an unbounded daemon. Reaching the cap is
 * reported rather than treated as completion.
 *
 * @param {object} options
 * @param {string} [options.type]
 * @param {number} [options.maxJobs]
 * @param {(info: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {() => Promise<{ allowed: boolean, reasons: string[] }>} [options.checkBudget]
 * @returns {Promise<{ completed: number, retried: number, failed: number,
 *   deferred: number, hitJobCap: boolean, stoppedByBudget: boolean,
 *   stoppedByQuota: boolean, quotaError: Error | null }>}
 */
export async function runUntilEmpty({
  type,
  maxJobs = 500,
  onProgress,
  signal,
  checkBudget,
} = {}) {
  const summary = {
    completed: 0,
    retried: 0,
    failed: 0,
    deferred: 0,
    hitJobCap: false,
    stoppedByBudget: false,
    stoppedByQuota: false,
    quotaError: null,
  };

  // Declared outside the loop: the post-loop job-cap check reads it, and a
  // `let` in the header would put it out of scope there.
  let processed = 0;

  for (; processed < maxJobs; processed += 1) {
    if (signal?.aborted) {
      break;
    }

    // Re-checked per job, not once per batch: a batch of 61 images can cross a
    // budget partway through, and a guard that only checks on entry cannot stop
    // that.
    if (checkBudget) {
      const status = await checkBudget();
      if (!status.allowed) {
        summary.stoppedByBudget = true;
        logger.warn('Stopping batch: budget guard refused further work', {
          reasons: status.reasons,
        });
        break;
      }
    }

    const { outcome, job, error } = await runOnce({ type, signal });

    if (outcome === 'idle') {
      break;
    }

    if (outcome === 'completed') {
      summary.completed += 1;
    } else if (outcome === 'deferred') {
      // Stop, do not continue. The quota is per model, not per image, so the
      // very next claim would hit the same wall. Carrying on would defer the
      // remaining 60 jobs one at a time and bury the single message that
      // actually explains what happened.
      summary.deferred += 1;
      summary.stoppedByQuota = true;
      summary.quotaError = error;
      onProgress?.({ event: 'deferred', job, error, delayMs });
      break;
    } else if (outcome === 'retry') {
      summary.retried += 1;
      const delay = backoffDelayMs(job.attempts);
      onProgress?.({ event: 'retry', job, error, delayMs: delay });
      await sleep(delay);
    } else {
      summary.failed += 1;
      onProgress?.({ event: 'failed', job, error });
    }
  }

  if (processed >= maxJobs) {
    summary.hitJobCap = true;
  }

  return summary;
}

/**
 * Used when the provider reports a quota wall but no recovery window.
 * An hour is deliberately long: guessing short is what turns a quota limit into
 * 183 pointless requests.
 */
const QUOTA_FALLBACK_DELAY_MS = 60 * 60 * 1000;

function describeJobFailure(error) {
  if (error instanceof Error) {
    const status = error.status ? ` (HTTP ${error.status})` : '';
    return `${error.name}: ${error.message}${status}`.slice(0, 2_000);
  }

  return String(error ?? 'unknown error').slice(0, 2_000);
}