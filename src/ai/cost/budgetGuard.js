/**
 * Budget guard.
 *
 * Stops new AI work when tracked spend reaches a configured ceiling
 * (docs/AI-PIPELINE.md, "Budget guard"). It is checked BEFORE a batch starts and
 * again before each item, because a batch of 61 images can cross a threshold
 * partway through.
 *
 * It compares against what ai_calls has already recorded, so the guard accounts
 * for failed and retried calls too rather than only successful ones.
 */

import { env } from '../../config/env.js';
import * as aiCallsRepository from '../../repositories/aiCalls.repository.js';
import { estimateCostUsd } from './pricing.js';

/**
 * INTERVAL values, passed to the repository as bind parameters and cast with
 * `::interval`. Values, not SQL fragments.
 */
const DAILY_INTERVAL = '1 day';
const MONTHLY_INTERVAL = '1 month';

/**
 * @typedef {object} BudgetStatus
 * @property {boolean} allowed        whether new work may start
 * @property {string[]} reasons       human-readable explanations when blocked
 * @property {number} dailySpendUsd
 * @property {number} monthlySpendUsd
 * @property {number | null} dailyLimitUsd
 * @property {number | null} monthlyLimitUsd
 * @property {number} projectedBatchCostUsd cost of the work about to be attempted
 */

/**
 * Read current spend and compare it with configured limits.
 *
 * @param {object} [options]
 * @param {number} [options.projectedBatchCostUsd] estimated cost of pending work
 * @param {number | null} [options.dailyLimitUsd]
 * @param {number | null} [options.monthlyLimitUsd]
 * @returns {Promise<BudgetStatus>}
 */
export async function checkBudget({
  projectedBatchCostUsd = 0,
  dailyLimitUsd = env.AI_DAILY_BUDGET_USD ?? null,
  monthlyLimitUsd = env.AI_MONTHLY_BUDGET_USD ?? null,
} = {}) {
  const [daily, monthly] = await Promise.all([
    aiCallsRepository.summariseAiCalls({ windowInterval: DAILY_INTERVAL }),
    aiCallsRepository.summariseAiCalls({ windowInterval: MONTHLY_INTERVAL }),
  ]);

  const dailySpendUsd = Number(daily.estimated_cost_usd ?? 0);
  const monthlySpendUsd = Number(monthly.estimated_cost_usd ?? 0);
  const reasons = [];

  if (dailyLimitUsd !== null && dailySpendUsd >= dailyLimitUsd) {
    reasons.push(
      `daily budget exhausted: ${formatUsd(dailySpendUsd)} spent of ${formatUsd(dailyLimitUsd)}`,
    );
  }

  if (monthlyLimitUsd !== null && monthlySpendUsd >= monthlyLimitUsd) {
    reasons.push(
      `monthly budget exhausted: ${formatUsd(monthlySpendUsd)} spent of ${formatUsd(monthlyLimitUsd)}`,
    );
  }

  // A budget that has not yet been crossed can still be crossed by the work
  // about to start. Refusing in advance is the whole point of a guard: after
  // the fact, the money is already spent.
  if (projectedBatchCostUsd > 0) {
    if (dailyLimitUsd !== null && dailySpendUsd + projectedBatchCostUsd > dailyLimitUsd) {
      reasons.push(
        `projected batch cost ${formatUsd(projectedBatchCostUsd)} would exceed the remaining `
          + `daily budget (${formatUsd(Math.max(0, dailyLimitUsd - dailySpendUsd))} left)`,
      );
    }

    if (monthlyLimitUsd !== null && monthlySpendUsd + projectedBatchCostUsd > monthlyLimitUsd) {
      reasons.push(
        `projected batch cost ${formatUsd(projectedBatchCostUsd)} would exceed the remaining `
          + `monthly budget (${formatUsd(Math.max(0, monthlyLimitUsd - monthlySpendUsd))} left)`,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    dailySpendUsd,
    monthlySpendUsd,
    dailyLimitUsd,
    monthlyLimitUsd,
    projectedBatchCostUsd,
  };
}

/**
 * Project the cost of a batch before running it.
 *
 * Deliberately pessimistic: it uses the largest per-call input seen for the
 * model where known, and otherwise a conservative constant. Under-projecting
 * would let a batch start that cannot finish within budget; over-projecting
 * merely triggers an early, explicable refusal.
 *
 * @param {object} options
 * @param {number} options.imageCount
 * @param {string} options.model
 * @param {Record<string, number>} [options.observedMaxInputTokens]
 * @returns {number} estimated USD for the whole batch
 */
export function projectBatchCostUsd({ imageCount, model, observedMaxInputTokens = {} }) {
  const worstObserved = Object.values(observedMaxInputTokens)
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((max, value) => Math.max(max, value), 0);

  // 1488 tokens/image was measured on the real corpus for gemini-3.5-flash
  // (1118 with thinking enabled, 1488 observed later with the revised prompt).
  // 2000 keeps headroom for a larger image without pretending to be precise.
  const inputTokensPerImage = worstObserved > 0 ? worstObserved : 2_000;
  const outputTokensPerImage = 256;

  return estimateCostUsd(model, {
    inputTokens: inputTokensPerImage * imageCount,
    outputTokens: outputTokensPerImage * imageCount,
  });
}

export function formatUsd(value) {
  const amount = Number(value ?? 0);

  if (!Number.isFinite(amount)) {
    return '$0.00';
  }

  // Sub-cent amounts must not all render as "$0.00", which is how a real cost
  // ends up looking like a free call.
  if (amount !== 0 && Math.abs(amount) < 0.01) {
    return `$${amount.toFixed(8).replace(/0+$/, '')}`;
  }

  return `$${amount.toFixed(4)}`;
}

/** Thrown when the budget guard refuses further work. */
export class BudgetExceededError extends Error {
  constructor(status) {
    super(`AI budget exceeded:\n  - ${status.reasons.join('\n  - ')}`);
    this.name = 'BudgetExceededError';
    this.status = status;
  }
}