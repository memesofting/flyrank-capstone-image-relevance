/**
 * Vision schema and classification.
 *
 * The central Phase 2 promise is that provider output is never trusted until it
 * has been schema-validated. These tests hold that line from both sides: well
 * formed output must survive, and every way a model can be wrong must be
 * rejected rather than coerced.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  imageUnderstandingSchema,
  geminiResponseSchema,
  SUBJECT_VOCABULARY,
} from '../../src/ai/schemas/imageUnderstanding.schema.js';
import {
  classifyVisionOutput,
  formatValidationIssues,
  IMAGE_STATUS_BY_VALIDATION,
  VALIDATION_STATUS,
} from '../../src/domain/visionClassification.js';
import { buildImageUnderstandingPrompt } from '../../src/ai/prompts/imageUnderstanding.prompt.js';
import { LOW_CONFIDENCE_THRESHOLD } from '../../src/config/constants.js';

describe('imageUnderstandingSchema', () => {
  const valid = {
    category: 'wildlife',
    subject: 'fox',
    attributes: ['red fur', 'pointed ears'],
    caption: 'A red fox standing in tall grass at dusk.',
    confidence: 0.93,
  };

  it('accepts a well formed response', () => {
    const result = imageUnderstandingSchema.safeParse(valid);
    assert.equal(result.success, true);
  });

  it('rejects an unknown subject rather than passing it through', () => {
    const result = imageUnderstandingSchema.safeParse({ ...valid, subject: 'dragon' });
    assert.equal(result.success, false);
  });

  it('accepts every subject in the controlled vocabulary', () => {
    for (const subject of SUBJECT_VOCABULARY) {
      assert.equal(
        imageUnderstandingSchema.safeParse({ ...valid, subject }).success,
        true,
        `expected "${subject}" to be accepted`,
      );
    }
  });

  it('rejects a differently cased subject', () => {
    // Models do return "Fox". Coercing the case here would make the vocabulary
    // advisory; rejecting keeps the stored value exactly reproducible.
    for (const subject of ['Fox', 'FOX', 'wOlF']) {
      assert.equal(
        imageUnderstandingSchema.safeParse({ ...valid, subject }).success,
        false,
        `expected "${subject}" to be rejected`,
      );
    }
  });

  it('enforces the vocabulary at the trust boundary, not only in the prompt', () => {
    // The vocabulary exists in three places. This asserts the one that matters:
    // providers that ignore responseSchema (Ollama) would otherwise persist a
    // made-up subject as a trusted VALID classification.
    assert.equal(geminiResponseSchema.properties.subject.enum.length, SUBJECT_VOCABULARY.length);
    assert.deepEqual(
      [...geminiResponseSchema.properties.subject.enum].sort(),
      [...SUBJECT_VOCABULARY].sort(),
      'the wire enum and the validation vocabulary must not drift',
    );
    assert.equal(classifyVisionOutput({ ...valid, subject: 'dragon' }).status, 'INVALID');
  });

  it('rejects missing fields rather than defaulting them', () => {
    for (const field of Object.keys(valid)) {
      const partial = { ...valid };
      delete partial[field];

      assert.equal(
        imageUnderstandingSchema.safeParse(partial).success,
        false,
        `expected a response missing "${field}" to be rejected`,
      );
    }
  });

  it('rejects a confidence outside 0..1', () => {
    assert.equal(imageUnderstandingSchema.safeParse({ ...valid, confidence: 1.1 }).success, false);
    assert.equal(imageUnderstandingSchema.safeParse({ ...valid, confidence: -0.1 }).success, false);
  });

  it('rejects extra properties instead of dropping them silently', () => {
    const result = imageUnderstandingSchema.safeParse({ ...valid, secret_field: 'ignore me' });
    assert.equal(result.success, false);
  });

  it('rejects a non-string subject', () => {
    assert.equal(imageUnderstandingSchema.safeParse({ ...valid, subject: 42 }).success, false);
  });

  it('rejects an empty caption', () => {
    assert.equal(imageUnderstandingSchema.safeParse({ ...valid, caption: '' }).success, false);
  });

  it('caps the attribute list', () => {
    const tooMany = {
      ...valid,
      attributes: Array.from({ length: 21 }, (_, i) => `attr-${i}`),
    };
    assert.equal(imageUnderstandingSchema.safeParse(tooMany).success, false);
  });

  it('requires at least one attribute', () => {
    assert.equal(imageUnderstandingSchema.safeParse({ ...valid, attributes: [] }).success, false);
  });

  it('rejects an object where a string is required', () => {
    assert.equal(
      imageUnderstandingSchema.safeParse({ ...valid, category: { name: 'wildlife' } }).success,
      false,
    );
  });
});

describe('classifyVisionOutput', () => {
  const base = {
    category: 'wildlife',
    subject: 'fox',
    attributes: ['red fur'],
    caption: 'A red fox in grass.',
    confidence: 0.9,
  };

  it('marks a confident, valid response VALID', () => {
    assert.equal(classifyVisionOutput(base).status, VALIDATION_STATUS.VALID);
  });

  it('flags a low-confidence response instead of discarding it', () => {
    // Flagged, not dropped: a reviewer has to be able to see what the model
    // claimed in order to judge it. The guard reads status, never confidence.
    const result = classifyVisionOutput({ ...base, confidence: 0.4 });
    assert.equal(result.status, VALIDATION_STATUS.LOW_CONFIDENCE);
    assert.equal(result.data.confidence, 0.4);
  });

  it('marks schema-invalid output INVALID and returns no data at all', () => {
    // data: null is load-bearing. A caller that forgets to check status still
    // cannot reach a populated object, so a missed branch cannot persist a
    // classification built from malformed input.
    const result = classifyVisionOutput({ subject: 'dragon' });
    assert.equal(result.status, VALIDATION_STATUS.INVALID);
    assert.equal(result.data, null);
  });

  it('gives a human-readable reason naming the offending field', () => {
    const result = classifyVisionOutput({ ...base, confidence: 'very' });
    assert.equal(result.status, VALIDATION_STATUS.INVALID);
    const reason = formatValidationIssues(result.issues);
    assert.match(reason, /confidence/i);
    assert.ok(reason.length > 0);
  });

  it('treats a non-object response as invalid rather than crashing', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      assert.equal(
        classifyVisionOutput(junk).status,
        VALIDATION_STATUS.INVALID,
        `expected ${JSON.stringify(junk) ?? 'undefined'} to be invalid`,
      );
    }
  });

  it('honours an explicit threshold override', () => {
    assert.equal(classifyVisionOutput({ ...base, confidence: 0.8 }, { threshold: 0.9 }).status,
      VALIDATION_STATUS.LOW_CONFIDENCE);
    assert.equal(classifyVisionOutput({ ...base, confidence: 0.4 }, { threshold: 0.1 }).status,
      VALIDATION_STATUS.VALID);
  });

  it('maps every validation status onto an image lifecycle state', () => {
    // FLAGGED must exist: it is how a low-confidence image becomes visible to
    // an operator without reading every metadata row.
    assert.deepEqual(IMAGE_STATUS_BY_VALIDATION, {
      VALID: 'READY',
      LOW_CONFIDENCE: 'FLAGGED',
      INVALID: 'FAILED',
    });
  });
});

describe('buildImageUnderstandingPrompt', () => {
  const prompt = buildImageUnderstandingPrompt();

  it('states the controlled subject vocabulary in the prompt text', () => {
    for (const subject of SUBJECT_VOCABULARY) {
      assert.ok(prompt.includes(subject), `prompt must name the subject "${subject}"`);
    }
  });

  it('includes the vocabulary in the schema it hands to the provider', () => {
    const schema = buildImageUnderstandingPrompt({ vocabulary: ['fox'] });
    assert.ok(schema.includes('fox'));
    assert.ok(!schema.includes('dragon'));
  });

  it('asks for JSON so the schema has something to validate', () => {
    assert.match(prompt, /json/i);
  });

  it('is deterministic, so one prompt version means one thing', () => {
    assert.equal(prompt, buildImageUnderstandingPrompt());
  });
});