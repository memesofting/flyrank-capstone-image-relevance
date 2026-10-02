/**
 * Model pricing for cost estimation.
 *
 * Figures are USD per one million tokens, from Google's published Gemini
 * Developer API price list at time of writing. They are used to produce an
 * ESTIMATE stored in ai_calls.estimated_cost_usd, not an invoice.
 *
 * Free tier versus paid tier cannot be detected from the API response, so this
 * deliberately prices against the PAID list. On the free tier that overestimates
 * — which is the safe direction for a budget guard: it can only ever stop work
 * earlier than strictly necessary, never later. An underestimate would let a
 * budget silently overrun, which is the failure that actually costs money.
 *
 * `docs/SUBMISSION.md` requires that the corpus run stays free. Phase 2's
 * measured run cost is recorded in EVIDENCE.md, and this table is why it can be
 * stated rather than assumed.
 */

/** USD per 1M tokens. */
export const MODEL_PRICING = Object.freeze({
  // Vision
  'gemini-3.8-flash': { inputPerMillionUsd: 0.375, outputPerMillionUsd: 1.875 },
  'gemini-3.6-flash': { inputPerMillionUsd: 0.375, outputPerMillionUsd: 1.875 },
  'gemini-3.5-flash': { inputPerMillionUsd: 1.5, outputPerMillionUsd: 9.0 },
  'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'gemini-3.1-flash-lite': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
  'gemini-flash-latest': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },

  // Embeddings. Gemini embedding pricing on the free tier is $0; the paid rate
  // is not consistently published per model. Rather than invent a number, the
  // embedding model records 0 with its token counts still stored, so a real rate
  // can be applied later and the totals recomputed without re-running anything.
  'gemini-embedding-001': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'gemini-embedding-2': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },

  // Test/stub providers perform no network call and cost nothing.
  'stub-vision-v1': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
  'stub-embedding-v1': { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
});

/**
 * Estimate the USD cost of one call.
 *
 * Returns 0 for an unknown model rather than throwing: an unpriced model must
 * not be able to abort a batch, and the token counts are persisted separately so
 * the gap is visible and recoverable.
 *
 * @param {string} model
 * @param {{ inputTokens?: number | null, outputTokens?: number | null }} usage
 * @returns {number} estimated USD
 */
export function estimateCostUsd(model, usage) {
  const rates = MODEL_PRICING[model];

  if (!rates) {
    return 0;
  }

  const inputTokens = Number(usage?.inputTokens ?? 0) || 0;
  const outputTokens = Number(usage?.outputTokens ?? 0) || 0;

  const cost =
    (inputTokens / 1_000_000) * rates.inputPerMillionUsd
    + (outputTokens / 1_000_000) * rates.outputPerMillionUsd;

  // ai_calls.estimated_cost_usd is NUMERIC(12,8): eight decimal places, so a
  // sub-cent call is representable rather than rounding to 0 and looking free.
  return Number(cost.toFixed(8));
}

/**
 * Whether a model has a published rate.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function hasPricing(model) {
  return Object.hasOwn(MODEL_PRICING, model);
}