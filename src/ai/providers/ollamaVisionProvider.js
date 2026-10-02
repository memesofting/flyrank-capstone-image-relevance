/**
 * Ollama vision provider.
 *
 * Present because "keep the project free to run" should mean offline too, and
 * because a provider abstraction with only one implementation is an interface
 * nobody has tested. Two adapters agreeing on one shape is what makes the seam
 * real (docs/AI-PIPELINE.md, "Provider abstraction").
 *
 * Not exercised by the Phase 2 gate: the project machine has 3.8 GB of RAM with
 * roughly 900 MB free, so no vision model that fits was available to run here.
 * It is implemented and unit-tested against mocked HTTP, and selecting it is a
 * one-line .env change. That limitation is recorded rather than papered over.
 */

import { env } from '../../config/env.js';
import { buildImageUnderstandingPrompt } from '../prompts/imageUnderstanding.prompt.js';
import { SUBJECT_VOCABULARY } from '../schemas/imageUnderstanding.schema.js';
import { ProviderError, parseJsonText, redactSecrets } from './geminiHttp.js';

/** Same classification between the two adapters, via HTTP status. */
function isTransientHttpStatus(status) {
  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return status >= 500;
}

export class OllamaVisionProvider {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} options.model
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   */
  constructor({ baseUrl, model, fetchImpl = globalThis.fetch, timeoutMs = 120_000 }) {
    this.name = 'ollama';
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    // Generous by comparison with Gemini: a CPU-bound local model on a small
    // machine is legitimately much slower than a hosted API.
    this.timeoutMs = timeoutMs;
  }

  static fromEnv({ model, fetchImpl } = {}) {
    return new OllamaVisionProvider({
      baseUrl: env.OLLAMA_BASE_URL,
      model: model ?? env.OLLAMA_VISION_MODEL,
      fetchImpl,
    });
  }

  async understandImage(imageBuffer, mimeType, { signal } = {}) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new ProviderError('understandImage requires a non-empty Buffer', {
        provider: 'ollama',
        model: this.model,
        transient: false,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          // Ollama's `format` takes a JSON Schema. The provider accepts "json"
          // too, but that only guarantees valid JSON, not a valid shape — the
          // Zod schema is what enforces the shape, exactly as with Gemini.
          format: {
            type: 'object',
            properties: {
              subject: { type: 'string', enum: [...SUBJECT_VOCABULARY] },
              category: { type: 'string' },
              attributes: { type: 'array', items: { type: 'string' } },
              caption: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['subject', 'category', 'attributes', 'caption', 'confidence'],
          },
          stream: false,
          // Zero for the same reproducibility reason as the Gemini provider.
          options: { temperature: 0 },
          messages: [
            {
              role: 'user',
              content: buildImageUnderstandingPrompt({ vocabulary: SUBJECT_VOCABULARY }),
              images: [imageBuffer.toString('base64')],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderError(
        controller.signal.aborted
          ? `Ollama request timed out after ${this.timeoutMs}ms`
          : `Ollama request failed: ${redactSecrets(error.message)}`,
        { provider: 'ollama', model: this.model, status: 0, transient: true },
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    const text = await response.text();

    if (!response.ok) {
      throw new ProviderError(
        `Ollama returned HTTP ${response.status}: ${redactSecrets(text.slice(0, 300))}`,
        {
          provider: 'ollama',
          model: this.model,
          status: response.status,
          transient: isTransientHttpStatus(response.status),
          body: text.slice(0, 500),
        },
      );
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new ProviderError(`Ollama returned a non-JSON body: ${error.message}`, {
        provider: 'ollama',
        model: this.model,
        status: response.status,
        transient: true,
      });
    }

    const parsed = parseJsonText(payload?.response ?? '');
    if (!parsed.ok) {
      throw new ProviderError(parsed.reason, {
        provider: 'ollama',
        model: this.model,
        status: response.status,
        transient: true,
        body: { modelText: String(payload?.response ?? '').slice(0, 500) },
      });
    }

    return {
      rawOutput: parsed.value,
      // Ollama reports prompt/eval counts, not a modality split, so image tokens
      // are not separately attributable. Recorded as null rather than guessed.
      usage: {
        inputTokens: payload?.prompt_eval_count ?? null,
        outputTokens: payload?.eval_count ?? null,
        imageTokens: null,
      },
    };
  }
}