/**
 * Job handlers.
 *
 * A handler's only job is to load the entity, do the work, and return. It must
 * NOT decide whether to retry: `shouldRetry` in jobRunner.js owns that, because
 * a handler that catches its own errors is a handler whose errors get swallowed.
 *
 * Handlers throw on failure and let the error propagate.
 */

import {
  DEFAULT_MODEL_VERSION,
  EMBEDDING_OPERATION,
  VISION_OPERATION,
  analyseImage,
  embedImageCaption,
} from '../../services/vision.service.js';
import { registerHandler } from '../jobRunner.js';
import * as imagesRepository from '../../repositories/images.repository.js';
import { logger } from '../../utils/logger.js';

export const VISION_JOB_TYPE = VISION_OPERATION;
export const EMBEDDING_JOB_TYPE = EMBEDDING_OPERATION;

/**
 * Vision analysis of one image.
 *
 * The entity is the image; the work is one API call. Retries are safe because
 * image_metadata is unique per (image, model, model_version, prompt_version) and
 * the write is an upsert, so a repeated attempt converges on one row.
 */
export function createVisionJobHandler({ visionProvider, modelVersion = DEFAULT_MODEL_VERSION }) {
  return async function visionJob({ job, signal, updateProgress }) {
    const image = await imagesRepository.findImageById(job.entity_id);

    if (!image) {
      // Permanent: the image cannot reappear.
      const error = new Error(`image ${job.entity_id} not found for job ${job.id}`);
      error.transient = false;
      throw error;
    }

    // Mark the image in flight so an operator watching `images.status` sees the
    // job is running, not stuck.
    await imagesRepository.updateImageStatus(image.id, 'PROCESSING');
    await updateProgress(10);

    try {
      return await analyseImage({
        image,
        visionProvider,
        modelVersion,
        jobId: job.id,
        signal,
      });
    } catch (error) {
      // Return the image to PENDING before rethrowing.
      //
      // The status was set to PROCESSING optimistically, so any failure — a
      // provider timeout, or a quota wall that will not clear for three hours —
      // would otherwise leave the row claiming to be in flight forever, with no
      // job actually running. The observed effect of not doing this was 61
      // images stuck in PROCESSING while the jobs table showed every one of them
      // FAILED, which reads as a corrupt database rather than a throttled run.
      //
      // Deferral matters here: a deferred job is going to be retried later, and
      // PENDING is exactly the state it will be claimed from.
      await imagesRepository.updateImageStatus(image.id, 'PENDING').catch((statusError) => {
        logger.error('Failed to reset image status after a failed attempt', {
          imageId: image.id,
          error: statusError.message,
        });
      });

      throw error;
    }
  };
}

/**
 * Caption embedding for one image.
 *
 * Runs after the vision job because it embeds the caption that job produced. If
 * it runs first, there is no caption and it fails permanently — which is correct
 * and is why ingestion enqueues the vision job and only enqueues embedding once
 * a validated caption exists.
 */
export function createEmbeddingJobHandler({ embeddingProvider, modelVersion = DEFAULT_MODEL_VERSION }) {
  return async function embeddingJob({ job, signal, updateProgress }) {
    const image = await imagesRepository.findImageById(job.entity_id);

    if (!image) {
      const error = new Error(`image ${job.entity_id} not found for job ${job.id}`);
      error.transient = false;
      throw error;
    }

    await updateProgress(25);

    const result = await embedImageCaption({
      image,
      embeddingProvider,
      modelVersion,
      jobId: job.id,
      signal,
      // Which analysis to embed, recorded by ingestion. See embedImageCaption.
      metadataId: job.payload?.metadataId ?? null,
      visionModel: job.payload?.visionModel ?? null,
    });

    await updateProgress(90);
    return result;
  };
}

/**
 * Register both handlers.
 *
 * @param {object} providers
 */
export function registerPhase2Handlers({ visionProvider, embeddingProvider, modelVersion }) {
  registerHandler(
    VISION_JOB_TYPE,
    createVisionJobHandler({ visionProvider, modelVersion }),
  );

  registerHandler(
    EMBEDDING_JOB_TYPE,
    createEmbeddingJobHandler({ embeddingProvider, modelVersion }),
  );

  logger.debug('Phase 2 job handlers registered', {
    visionModel: visionProvider.model,
    embeddingModel: embeddingProvider.model,
  });
}