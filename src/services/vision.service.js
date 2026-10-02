/**
 * Vision understanding service.
 *
 * The single place where provider output becomes trusted metadata. Every path
 * into `image_metadata` goes through `analyseImage`, which means requirement 1
 * ("invalid AI output is rejected") is enforced once rather than per caller.
 *
 * The order of operations is the design:
 *
 *   1. call the provider
 *   2. record the call's cost          <- even if the answer is about to be
 *   3. classify with Zod
 *   4. persist ONLY if the classification is VALID or LOW_CONFIDENCE
 *   5. map the classification onto images.status
 *
 * Step 4 is the requirement. An INVALID classification writes no metadata row,
 * so "invalid output is never trusted" is a property of the database contents
 * and not merely of a branch that was hopefully taken. The raw provider
 * response is still persisted to ai_calls, so the failure remains inspectable.
 */

import { readFile } from 'node:fs/promises';

import {
  LOW_CONFIDENCE_THRESHOLD,
  PROMPT_VERSION,
} from '../config/constants.js';
import {
  IMAGE_STATUS_BY_VALIDATION,
  VALIDATION_STATUS,
  classifyVisionOutput,
  formatValidationIssues,
} from '../domain/visionClassification.js';
import { trackCall } from '../ai/cost/costTracker.js';
import * as imagesRepository from '../repositories/images.repository.js';
import { logger } from '../utils/logger.js';

/**
 * Model version stamped on every analysis.
 *
 * Pinned to the model's release identity rather than a date, so that re-running
 * against the same model converges on the same idempotency key and does not
 * create a duplicate analysis.
 */
export const DEFAULT_MODEL_VERSION = '2026-01';

/**
 * Operation names.
 *
 * Single source of truth: these appear in job types, in ai_calls.operation, and
 * in idempotency keys, so defining them twice would let a typo make a cost row
 * and a job disagree about what was done.
 */
export const VISION_OPERATION = 'vision.understand';
export const EMBEDDING_OPERATION = 'embedding.embed';

/**
 * Analyse one image and persist the result.
 *
 * @param {object} params
 * @param {object} params.image row from the images table
 * @param {object} params.visionProvider an implementation of understandImage
 * @param {string} [params.modelVersion]
 * @param {string} [params.promptVersion]
 * @param {number} [params.threshold] low-confidence cut-off
 * @param {string} [params.jobId] links the cost record to the job that made it
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<object>} outcome including status and whether it was persisted
 */
export async function analyseImage({
  image,
  visionProvider,
  modelVersion = DEFAULT_MODEL_VERSION,
  promptVersion = PROMPT_VERSION,
  threshold = LOW_CONFIDENCE_THRESHOLD,
  jobId = null,
  signal,
}) {
  const model = visionProvider.model;

  const bytes = await readImageBytes(image.storage_key);

  // The provider call is wrapped so its cost is recorded whether it succeeds,
  // fails, or returns output that turns out to be unusable.
  const { rawOutput, usage } = await trackCall(
    {
      provider: visionProvider.name,
      model,
      operation: VISION_OPERATION,
      jobId,
    },
    () => visionProvider.understandImage(bytes, image.mime_type, { signal }),
  );

  const classification = classifyVisionOutput(rawOutput, { threshold });

  if (classification.status === VALIDATION_STATUS.INVALID) {
    // Deliberately no metadata row. The image is marked FAILED so an operator
    // can see it, and the reason is logged and attached to the job.
    const reason = formatValidationIssues(classification.issues);

    await imagesRepository.updateImageStatus(image.id, IMAGE_STATUS_BY_VALIDATION.INVALID);

    logger.warn('Vision output failed schema validation; not persisted', {
      imageId: image.id,
      model,
      promptVersion,
      issues: classification.issues,
    });

    return {
      imageId: image.id,
      status: VALIDATION_STATUS.INVALID,
      persisted: false,
      model,
      modelVersion,
      promptVersion,
      usage,
      issues: classification.issues,
      reason,
    };
  }

  const data = classification.data;

  // Safe: classification.data is non-null for both VALID and LOW_CONFIDENCE,
  // and this branch is unreachable for INVALID.
  const metadata = await imagesRepository.insertImageMetadata({
    imageId: image.id,
    model,
    modelVersion,
    promptVersion,
    subject: data.subject,
    category: data.category,
    attributes: data.attributes,
    caption: data.caption,
    confidence: data.confidence,
    rawResponse: rawOutput,
    validationStatus: classification.status,
  });

  await imagesRepository.updateImageStatus(
    image.id,
    IMAGE_STATUS_BY_VALIDATION[classification.status],
  );

  logger.info('Vision analysis stored', {
    imageId: image.id,
    status: classification.status,
    subject: data.subject,
    confidence: data.confidence,
    model,
    promptVersion,
    reusedExistingRow: metadata.created === false,
  });

  return {
    imageId: image.id,
    status: classification.status,
    persisted: true,
    model,
    modelVersion,
    promptVersion,
    subject: data.subject,
    category: data.category,
    confidence: data.confidence,
    usage,
    reusedExistingRow: metadata.created === false,
  };
}

/**
 * Embed an image's caption.
 *
 * Phase 2's half of the required flow. The caption — not the image bytes — is
 * embedded, because Phase 3 compares image vectors against POST vectors: only
 * two texts in one space are comparable. Embedding pixels into a different space
 * than post prose would produce a cosine score that looks meaningful and is not.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function embedImageCaption({
  image,
  embeddingProvider,
  modelVersion = DEFAULT_MODEL_VERSION,
  jobId = null,
  signal,
}) {
  const metadata = await imagesRepository.findImageMetadata(image.id, {
    model: embeddingProvider.model,
  });

  if (!metadata) {
    throw Object.assign(
      new Error(`image ${image.id} has no vision metadata to embed`),
      { transient: false },
    );
  }

  // Category and attributes travel with the caption because the guard reads all
  // three, and a vector built from the bare caption would understate what the
  // pipeline actually knows about the image.
  const sourceText = [
    metadata.caption,
    `Subject: ${metadata.subject}.`,
    `Category: ${metadata.category}.`,
    `Attributes: ${metadata.attributes.join(', ')}.`,
  ].join(' ');

  const { vector, usage } = await trackCall(
    {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      operation: EMBEDDING_OPERATION,
      jobId,
    },
    () => embeddingProvider.embedText(sourceText, { taskType: 'RETRIEVAL_DOCUMENT', signal }),
  );

  const row = await imagesRepository.insertImageEmbedding({
    imageId: image.id,
    model: embeddingProvider.model,
    modelVersion,
    embedding: vector,
    dimensions: vector.length,
    sourceText,
    provider: embeddingProvider.name,
    normalized: true,
  });

  logger.debug('Image caption embedded', {
    imageId: image.id,
    model: embeddingProvider.model,
    dimensions: vector.length,
  });

  return {
    imageId: image.id,
    embeddingId: row.id,
    model: embeddingProvider.model,
    dimensions: vector.length,
    usage,
  };
}

async function readImageBytes(storageKey) {
  return readFile(storageKey);
}