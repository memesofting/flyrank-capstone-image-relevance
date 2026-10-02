/**
 * Provider factory.
 *
 * The single place that maps configuration to a concrete adapter. Callers ask
 * for a capability — "a vision provider" — and receive something implementing
 * it, which is what keeps Gemini-specific shapes from spreading through the
 * services (docs/AI-PIPELINE.md, "Provider abstraction").
 */

import { env } from '../../config/env.js';
import {
  EMBEDDING_MODEL,
  VISION_MODEL,
  VISION_MODEL_FALLBACK,
} from '../../config/constants.js';
import { GeminiEmbeddingProvider } from './geminiEmbeddingProvider.js';
import { GeminiVisionProvider } from './geminiVisionProvider.js';
import { OllamaVisionProvider } from './ollamaVisionProvider.js';
import { StubEmbeddingProvider, StubVisionProvider } from './stubProviders.js';

/**
 * Resolve a vision provider from configuration.
 *
 * @param {object} [options]
 * @param {'gemini' | 'ollama'} [options.provider]
 * @param {string} [options.model] overrides the configured/default model
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {{ get provider(): object, primaryModel: string, fallbackModel: string | null }}
 */
export function createVisionProvider({ provider, model, fetchImpl } = {}) {
  const selected = provider ?? env.VISION_PROVIDER ?? 'gemini';

  if (selected === 'stub' || env.AI_PROVIDER_MODE === 'stub') {
    return {
      provider: new StubVisionProvider(),
      primaryModel: 'stub-vision-v1',
      fallbackModel: null,
    };
  }

  const chosen = model ?? env.VISION_MODEL ?? VISION_MODEL;

  if (selected === 'ollama') {
    return {
      provider: OllamaVisionProvider.fromEnv({ model: chosen, fetchImpl }),
      primaryModel: chosen,
      fallbackModel: null,
    };
  }

  const fallback = env.VISION_MODEL_FALLBACK ?? VISION_MODEL_FALLBACK;

  return {
    provider: GeminiVisionProvider.fromEnv({ model: chosen, fetchImpl }),
    primaryModel: chosen,
    // Only meaningful for Gemini. A fallback is offered because model
    // availability moved underneath this project: gemini-2.5-flash is listed by
    // the API but 404s for new accounts, and gemini-3.8-flash returned 503 under
    // load. See docs/adr/004-vision-model-availability.md.
    fallbackModel: fallback === chosen ? null : fallback,
  };
}

/**
 * Resolve an embedding provider.
 *
 * @param {object} [options]
 * @param {'gemini' | 'ollama'} [options.provider]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createEmbeddingProvider({ provider, fetchImpl } = {}) {
  const selected = provider ?? env.EMBEDDING_PROVIDER ?? 'gemini';

  if (selected === 'stub' || env.AI_PROVIDER_MODE === 'stub') {
    return { provider: new StubEmbeddingProvider(), model: 'stub-embedding-v1' };
  }

  if (selected === 'ollama') {
    throw new Error(
      'Ollama embeddings are not implemented. Phase 2 embeds with Gemini; '
        + 'choose EMBEDDING_PROVIDER=gemini.',
    );
  }

  const instance = GeminiEmbeddingProvider.fromEnv({ fetchImpl });
  return { provider: instance, model: env.EMBEDDING_MODEL ?? EMBEDDING_MODEL };
}

/**
 * Build providers for tests and dry runs.
 *
 * @returns {{ visionProvider: object, embeddingProvider: object }}
 */
export function createStubProviders() {
  return {
    visionProvider: new StubVisionProvider(),
    embeddingProvider: new StubEmbeddingProvider(),
  };
}