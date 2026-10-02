/**
 * Gemini vision provider.
 *
 * Adapts the Gemini REST wire format to the project's internal vision
 * representation. Nothing outside this file knows that Gemini nests text under
 * `candidates[0].content.parts` or reports usage as `usageMetadata`
 * (docs/AI-PIPELINE.md, "Provider abstraction").
 */

import { env } from '../../config/env.js';
import {
  buildImageUnderstandingPrompt,
} from '../prompts/imageUnderstanding.prompt.js';
import {
  geminiResponseSchema,
  SUBJECT_VOCABULARY,
} from '../schemas/imageUnderstanding.schema.js';
import {
  ProviderError,
  callGemini,
  extractCandidateText,
  parseJsonText,
} from './geminiHttp.js';

/**
 * @typedef {object} VisionResult
 * @property {unknown} rawOutput decoded JSON exactly as the model produced it
 * @property {{ inputTokens: number | null, outputTokens: number | null, imageTokens: number | null }} usage
 */

export class GeminiVisionProvider {
  /**
   * @param {object} options
   * @param {string} options.model
   * @param {string} options.apiKey
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.thinkingBudget]
   */
  constructor({ model, apiKey, fetchImpl = globalThis.fetch, thinkingBudget }) {
    this.name = 'gemini';
    this.model = model;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.thinkingBudget = thinkingBudget;
  }

  /** Static factory from validated environment. */
  static fromEnv({ model, fetchImpl } = {}) {
    return new GeminiVisionProvider({
      model: model ?? env.VISION_MODEL,
      apiKey: env.GEMINI_API_KEY,
      fetchImpl,
      thinkingBudget: env.GEMINI_THINKING_BUDGET,
    });
  }

  /**
   * Describe one image.
   *
   * @param {Buffer} imageBuffer raw image bytes
   * @param {string} mimeType
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<VisionResult>}
   */
  async understandImage(imageBuffer, mimeType, { signal } = {}) {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new ProviderError('understandImage requires a non-empty Buffer', {
        provider: 'gemini',
        model: this.model,
        transient: false,
      });
    }

    const generationConfig = {
      // Structured output. The model is constrained to the schema rather than
      // asked politely for JSON, which is what makes the enum reliable.
      responseMimeType: 'application/json',
      responseSchema: geminiResponseSchema,
      // Classification, not creative writing. Zero is the defensible default:
      // a non-zero temperature makes the same image classify differently across
      // runs, which would quietly poison any later precision measurement.
      temperature: 0,
      maxOutputTokens: 1024,
    };

    // Measured on gemini-3.5-flash: thinking cost 220 tokens per image for no
    // accuracy gain on a classification task, so it defaults to 0 and can be
    // re-enabled by configuration rather than by editing code.
    if (this.thinkingBudget === 0) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    } else if (typeof this.thinkingBudget === 'number') {
      generationConfig.thinkingConfig = { thinkingBudget: this.thinkingBudget };
    }

    const { data, usage } = await callGemini({
      model: this.model,
      method: 'generateContent',
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      signal,
      body: {
        contents: [
          {
            parts: [
              { text: buildImageUnderstandingPrompt({ vocabulary: SUBJECT_VOCABULARY }) },
              {
                // snake_case per the Gemini REST reference. The camelCase
                // spelling is accepted elsewhere in this API but not here.
                inline_data: {
                  mime_type: mimeType,
                  data: imageBuffer.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig,
      },
    });

    // generateContent-specific response checks live here, not in the shared
    // transport, because embedContent has a different shape and would be
    // rejected by them.
    //
    // A 200 can still carry an error block, and a candidate list can come back
    // empty when the request was blocked. Both would otherwise surface as an
    // unhelpful "cannot read properties of undefined" further downstream.
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new ProviderError(`Gemini blocked the request: ${blockReason}`, {
        provider: 'gemini',
        model: this.model,
        status: 200,
        transient: false,
        body: data.promptFeedback,
      });
    }

    if (!Array.isArray(data.candidates) || data.candidates.length === 0) {
      throw new ProviderError(`Gemini returned no candidates from ${this.model}:generateContent`, {
        provider: 'gemini',
        model: this.model,
        status: 200,
        transient: true,
        body: data,
      });
    }

    const text = extractCandidateText(data);

    // Truncation is a transport-level problem, not a validation one: the JSON is
    // incomplete, so classifying it would report INVALID and permanently fail an
    // image that a retry can still analyse. Surfacing it as transient lets the
    // job runner try again.
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new ProviderError(`Gemini stopped early (finishReason: ${finishReason})`, {
        provider: 'gemini',
        model: this.model,
        status: 200,
        transient: finishReason === 'MAX_TOKENS',
        body: data.candidates?.[0],
      });
    }

    const parsed = parseJsonText(text);
    if (!parsed.ok) {
      throw new ProviderError(parsed.reason, {
        provider: 'gemini',
        model: this.model,
        status: 200,
        // Malformed output can be genuine provider misbehaviour, so one retry
        // is reasonable. It is NOT repaired or coerced either way.
        transient: true,
        body: { modelText: text.slice(0, 500) },
      });
    }

    return {
      rawOutput: parsed.value,
      usage: {
        inputTokens: usage?.promptTokenCount ?? null,
        outputTokens: usage?.candidatesTokenCount ?? null,
        imageTokens: usage?.promptTokensDetails?.find?.((entry) => entry.modality === 'IMAGE')
          ?.tokenCount ?? null,
      },
    };
  }
}