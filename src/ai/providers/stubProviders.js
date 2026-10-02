/**
 * Deterministic in-memory providers for tests.
 *
 * Phase 1's suite passes with no database and no credentials. This keeps that
 * property for Phase 2: the whole pipeline — Zod validation, classification,
 * cost tracking, job retry, persistence — is exercised without a network call
 * and without spending free-tier quota.
 *
 * Output is derived from a hash of the image bytes, so it is stable across runs
 * and machines while still varying per image. Nothing here is hard-coded
 * metadata: it is obviously synthetic, exists only in tests, and never reaches
 * a real corpus run because production selects a live provider.
 */

import { createHash } from 'node:crypto';

import { SUBJECT_VOCABULARY } from '../schemas/imageUnderstanding.schema.js';

function digest(buffer) {
  return createHash('sha256').update(buffer).digest();
}

/**
 * Choose an output shape from the image bytes.
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {boolean} [options.forceInvalid] emit malformed output, to prove the
 *   pipeline refuses to persist it
 * @param {boolean} [options.forceLowConfidence] emit a below-threshold
 *   confidence, to exercise the LOW_CONFIDENCE path
 * @param {number} [options.failuresBeforeSuccess] throw this many times first
 */
export class StubVisionProvider {
  constructor({ fetchImpl } = {}) {
    this.name = 'stub';
    this.model = 'stub-vision-v1';
    this.calls = 0;
    this.options = fetchImpl;
  }

  async understandImage(imageBuffer, mimeType, { forceInvalid, forceLowConfidence, failuresBeforeSuccess } = {}) {
    this.calls += 1;

    const remainingFailures = (failuresBeforeSuccess ?? 0) - this.calls + 1;
    if (remainingFailures > 0) {
      const error = new Error(`stub provider failing on purpose (attempt ${this.calls})`);
      error.transient = true;
      error.provider = 'stub';
      error.model = this.model;
      throw error;
    }

    if (forceInvalid) {
      // Confidence out of range plus a missing subject: two of the rejection
      // classes the phase doc names, in one object.
      return {
        rawOutput: { category: 'wildlife', confidence: 5, caption: 'deliberately invalid' },
        usage: { inputTokens: 100, outputTokens: 20, imageTokens: 80 },
      };
    }

    const bytes = digest(imageBuffer);
    const subject = SUBJECT_VOCABULARY[bytes[0] % SUBJECT_VOCABULARY.length];
    const confidence = forceLowConfidence
      ? 0.2
      : Math.round((0.75 + (bytes[1] / 255) * 0.24) * 10_000) / 10_000;

    return {
      rawOutput: {
        subject,
        category: 'stub-category',
        attributes: [`stub-attribute-${bytes[2]}`, `stub-attribute-${bytes[3]}`],
        caption: `Stub caption for a ${subject} image (${mimeType}).`,
        confidence,
      },
      usage: { inputTokens: 100, outputTokens: 20, imageTokens: 80 },
    };
  }
}

/** Deterministic embedding of the requested dimension. */
export class StubEmbeddingProvider {
  constructor({ dimensions = 768 } = {}) {
    this.name = 'stub';
    this.model = 'stub-embedding-v1';
    this.dimensions = dimensions;
    this.calls = 0;
  }

  async embedText(text, { taskType } = {}) {
    this.calls += 1;

    const bytes = digest(Buffer.from(String(text), 'utf8'));
    const vector = Array.from({ length: this.dimensions }, (_, index) => {
      const byte = bytes[index % bytes.length];
      // Deterministic, non-uniform, and never all-zero.
      return ((byte / 255) * 2 - 1) * (1 + (index % 7) / 10);
    });

    return {
      vector: vector.map((value) => value / Math.hypot(...vector)),
      usage: { inputTokens: String(text).length },
    };
  }
}