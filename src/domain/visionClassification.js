/**
 * Vision output classification.
 *
 * Domain layer and pure: no database, no provider, no clock beyond its argument.
 *
 * This module answers exactly one question — given raw provider output, is it
 * VALID, LOW_CONFIDENCE or INVALID? — and it is the only place that answers it.
 * Keeping it pure and separate is what lets the requirement "invalid output is
 * never trusted" be tested directly, instead of inferred from the absence of
 * bad rows in the database.
 */

import { LOW_CONFIDENCE_THRESHOLD } from '../config/constants.js';
import { validateImageUnderstanding } from '../ai/schemas/imageUnderstanding.schema.js';

/**
 * @typedef {'VALID' | 'LOW_CONFIDENCE' | 'INVALID'} VisionValidationStatus
 */

/** Maps to image_metadata.validation_status. */
export const VALIDATION_STATUS = Object.freeze({
  VALID: 'VALID',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  INVALID: 'INVALID',
});

/**
 * Classify raw provider output.
 *
 * Order matters. Schema validity is checked FIRST, so a response with
 * `confidence: 5` is INVALID rather than being silently clamped into
 * LOW_CONFIDENCE, and a response with `confidence: "high"` is INVALID rather
 * than coerced. Confidence is only consulted about well-formed data.
 *
 * @param {unknown} raw the provider's decoded JSON, exactly as received
 * @param {object} [options]
 * @param {number} [options.threshold] low-confidence cut-off
 * @returns {{ status: VisionValidationStatus, data: object | null, issues: {path: string, message: string}[] }}
 */
export function classifyVisionOutput(raw, { threshold = LOW_CONFIDENCE_THRESHOLD } = {}) {
  const validation = validateImageUnderstanding(raw);

  if (!validation.success) {
    // `data: null` is the important part. A caller that ignores `status` still
    // cannot reach a populated object, so a missed branch cannot produce a
    // persisted classification out of malformed input.
    return {
      status: VALIDATION_STATUS.INVALID,
      data: null,
      issues: validation.issues,
    };
  }

  const data = validation.data;

  if (data.confidence < threshold) {
    // Still persisted, still visible, and NOT trusted. The data is returned
    // because a reviewer needs to see what the model actually claimed in order
    // to judge it; the guard reads `status`, not the confidence value.
    return { status: VALIDATION_STATUS.LOW_CONFIDENCE, data, issues: [] };
  }

  return { status: VALIDATION_STATUS.VALID, data, issues: [] };
}

/**
 * Map a validation status onto the images.status lifecycle column.
 *
 * images.status is the coarse, indexable state a worker scans; image_metadata
 * keeps the fine-grained reason. FLAGGED exists so a low-confidence image is
 * visible to an operator without reading every metadata row.
 */
export const IMAGE_STATUS_BY_VALIDATION = Object.freeze({
  VALID: 'READY',
  LOW_CONFIDENCE: 'FLAGGED',
  INVALID: 'FAILED',
});

/** Render issues into one human-readable line for logs and job.last_error. */
export function formatValidationIssues(issues) {
  if (!issues || issues.length === 0) {
    return 'no validation detail available';
  }

  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}