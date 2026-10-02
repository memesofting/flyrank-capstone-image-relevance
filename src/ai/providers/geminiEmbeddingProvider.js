/**
 * Gemini embedding provider.
 *
 * Two findings from live calls shaped this file, both recorded in
 * docs/adr/002-embedding-dimension.md:
 *
 *  1. `text-embedding-004`, which Phase 1 named as the justification for
 *     vector(768), is deprecated and absent from the provider's model list.
 *     `gemini-embedding-001` at `outputDimensionality: 768` is the replacement,
 *     and it returns exactly 768 floats.
 *
 *  2. Only the default 3072-dimensional output is pre-normalised. Measured L2
 *     norms: 3072 -> 1.000000, 768 -> 0.587787. Cosine similarity is invariant
 *     under scaling, so pgvector's `<=>` operator would compute the right answer
 *     either way — but a stored vector whose magnitude means nothing is a trap
 *     for the inner-product operator `<#>`, and for any future consumer that
 *     multiplies instead of normalising. Normalising here makes the stored data
 *     self-consistent regardless of which operator reads it.
 */

import { env } from '../../config/env.js';
import { EMBEDDING_DIMENSION, EMBEDDING_MODEL } from '../../config/constants.js';
import { ProviderError, callGemini } from './geminiHttp.js';

/**
 * L2-normalise a vector in place and return it.
 *
 * Exported because it is the single definition of the project's normalisation
 * rule, and the test that proves vectors are normalised should call exactly this
 * function rather than reimplementing it.
 *
 * @param {number[]} vector
 * @returns {number[]}
 */
export function l2Normalize(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('cannot normalise an empty embedding vector');
  }

  let sumOfSquares = 0;
  for (const value of vector) {
    sumOfSquares += value * value;
  }

  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) {
    // Returning the zero vector unchanged is the silent failure this guards
    // against: it satisfies every length check, reaches pgvector, and then
    // matches nothing under cosine similarity forever. Failing here keeps the
    // problem attached to the provider response that caused it.
    throw new Error('cannot normalise a zero embedding vector: the provider returned no signal');
  }

  return vector.map((value) => value / norm);
}

export class GeminiEmbeddingProvider {
  /**
   * @param {object} options
   * @param {string} [options.model]
   * @param {number} [options.dimensions]
   * @param {string} options.apiKey
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({
    model = EMBEDDING_MODEL,
    dimensions = EMBEDDING_DIMENSION,
    apiKey,
    fetchImpl = globalThis.fetch,
  }) {
    this.name = 'gemini';
    this.model = model;
    this.dimensions = dimensions;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  static fromEnv({ fetchImpl } = {}) {
    return new GeminiEmbeddingProvider({
      model: env.EMBEDDING_MODEL ?? EMBEDDING_MODEL,
      apiKey: env.GEMINI_API_KEY,
      fetchImpl,
    });
  }

  /**
   * Embed text.
   *
   * @param {string} text
   * @param {object} [options]
   * @param {'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY'} [options.taskType]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ vector: number[], usage: { inputTokens: number | null } }>}
   */
  async embedText(text, { taskType = 'RETRIEVAL_DOCUMENT', signal } = {}) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ProviderError('embedText requires non-empty text', {
        provider: 'gemini',
        model: this.model,
        transient: false,
      });
    }

    // `content` is SINGULAR here. Passing `contents` — the shape generateContent
    // wants — fails with 400 "Unknown name 'contents'", which cost real time
    // during planning.
    const { data } = await callGemini({
      model: this.model,
      method: 'embedContent',
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      signal,
      body: {
        content: { parts: [{ text }] },
        outputDimensionality: this.dimensions,
        taskType,
      },
    });

    const values = data?.embedding?.values;

    if (!Array.isArray(values) || values.length === 0) {
      throw new ProviderError('Gemini returned no embedding values', {
        provider: 'gemini',
        model: this.model,
        status: 200,
        transient: true,
        body: data,
      });
    }

    if (values.length !== this.dimensions) {
      // A dimension mismatch would be caught by pgvector at INSERT time as an
      // opaque "expected 768 dimensions, not N". Failing here names the actual
      // cause and which model produced it.
      throw new ProviderError(
        `Gemini returned ${values.length} dimensions but ${this.model} was configured for ${this.dimensions}`,
        { provider: 'gemini', model: this.model, status: 200, transient: false },
      );
    }

    return {
      vector: l2Normalize(values),
      usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? null },
    };
  }
}